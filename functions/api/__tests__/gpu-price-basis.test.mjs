/**
 * Regression tests for the GPU price-basis transition.
 *
 * The bug these exist to prevent: on 2026-07-28 the upstream replaced its
 * per-vendor min-max range with a single median. The parser of the day kept
 * looking for a range, so the lone price landed in maxPricePerHour and every
 * August cell rendered blank. When the parser was repaired on 2026-09-11 the
 * price reappeared under a DIFFERENT measure, and the matrix showed H100
 * going from $0.40 to $3.34 with a blank month in between — a five-fold
 * "jump" that never happened in the market.
 *
 * The fixtures below are the real captured shapes, values included.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASIS_FLOOR,
  BASIS_MEDIAN,
  isSingleValueInMaxField,
  normalizeDailyPoint,
  normalizeDailySeries,
  periodHeadline,
  pricedDatesForBasis,
  periodGrowth,
  growthRefusalReason,
  detectBasisTimeline,
  basisChangeForPeriods,
  pctChange,
} from '../_gpu-price-basis.js';

// ── Real captured shapes ─────────────────────────────────────────────────
// era 1: legacy range row  (2026-07-27, Nvidia H100)
const ERA1 = {
  date: '2026-07-27',
  minPricePerHour: 0.3478,
  maxPricePerHour: 14.9,
  medianPricePerHour: null,
  priceMidpoint: 7.6239,
  spreadMultiple: 42.84,
  spreadAbsolute: 14.5522,
  providerCount: 48,
};
// era 2: card layout, price stranded in maxPricePerHour (2026-07-28)
const ERA2 = {
  date: '2026-07-28',
  minPricePerHour: null,
  maxPricePerHour: 2.97,
  medianPricePerHour: null,
  priceMidpoint: null,
  spreadMultiple: null,
  spreadAbsolute: null,
  providerCount: 48,
};
// era 3: card layout, parser repaired (2026-09-16)
const ERA3 = {
  date: '2026-09-16',
  minPricePerHour: null,
  maxPricePerHour: null,
  medianPricePerHour: 3.3819,
  priceMidpoint: null,
  spreadMultiple: null,
  spreadAbsolute: null,
  providerCount: 53,
};

function day(date, over) {
  return { date, minPricePerHour: null, maxPricePerHour: null, medianPricePerHour: null,
           priceMidpoint: null, spreadMultiple: null, spreadAbsolute: null, providerCount: 50, ...over };
}

/* ── The remap rule ───────────────────────────────────────────────────── */

test('era-2 shape is recognised as a stranded single value', () => {
  assert.equal(isSingleValueInMaxField(ERA2), true);
});

test('era-1 range is NOT remapped — it has a midpoint and a spread', () => {
  assert.equal(isSingleValueInMaxField(ERA1), false);
  const n = normalizeDailyPoint(ERA1);
  assert.equal(n.dailyBasis, BASIS_FLOOR);
  assert.equal(n.dailyPrice, 0.3478);
  assert.equal(n.basisRemapped, false);
  // The $14.90 ceiling must stay a ceiling. If it ever leaks into the median
  // series the whole chart moves by an order of magnitude.
  assert.equal(n.maxPricePerHour, 14.9);
  assert.equal(n.medianPricePerHour, null);
});

test('era-2 price is recovered as a median, and the phantom ceiling is cleared', () => {
  const n = normalizeDailyPoint(ERA2);
  assert.equal(n.dailyBasis, BASIS_MEDIAN);
  assert.equal(n.dailyPrice, 2.97);
  assert.equal(n.medianPricePerHour, 2.97);
  assert.equal(n.basisRemapped, true);
  // There was never a range, so reporting 2.97 as a ceiling would render a
  // zero-width market in the tooltip.
  assert.equal(n.maxPricePerHour, null);
});

test('era-3 needs no rescue', () => {
  const n = normalizeDailyPoint(ERA3);
  assert.equal(n.dailyBasis, BASIS_MEDIAN);
  assert.equal(n.dailyPrice, 3.3819);
  assert.equal(n.basisRemapped, false);
});

test('a max that survives WITH a min is never remapped', () => {
  // Defends the narrow rule: only a max with no min, no midpoint and no
  // spread is a stranded single value.
  const withMidpoint = day('2026-06-01', { maxPricePerHour: 9, priceMidpoint: 5 });
  assert.equal(isSingleValueInMaxField(withMidpoint), false);
  const withSpread = day('2026-06-02', { maxPricePerHour: 9, spreadMultiple: 3 });
  assert.equal(isSingleValueInMaxField(withSpread), false);
  const withMin = day('2026-06-03', { maxPricePerHour: 9, minPricePerHour: 1 });
  assert.equal(isSingleValueInMaxField(withMin), false);
});

test('a day with no price at all stays unpriced', () => {
  const n = normalizeDailyPoint(day('2026-06-04', { providerCount: 40 }));
  assert.equal(n.dailyBasis, null);
  assert.equal(n.dailyPrice, null);
});

test('normalization does not mutate the stored record', () => {
  const src = { ...ERA2 };
  normalizeDailyPoint(src);
  assert.equal(src.maxPricePerHour, 2.97, 'raw snapshot must stay as captured');
  assert.equal(src.medianPricePerHour, null);
});

/* ── Period headline: the dominant-basis rule ─────────────────────────── */

test('a clean floor month reports the floor', () => {
  const pts = normalizeDailySeries([
    day('2026-06-01', { minPricePerHour: 0.5, maxPricePerHour: 14.9, priceMidpoint: 7.7, spreadMultiple: 29.8 }),
    day('2026-06-02', { minPricePerHour: 0.7, maxPricePerHour: 14.9, priceMidpoint: 7.8, spreadMultiple: 21.3 }),
  ]);
  const h = periodHeadline(pts);
  assert.equal(h.priceBasis, BASIS_FLOOR);
  assert.equal(h.headlinePricePerHour, 0.6);
  assert.equal(h.mixedBasis, false);
  assert.equal(h.alternatePricePerHour, null);
});

test('August populates from era-2 days instead of reading as "no price"', () => {
  // This is the customer-visible bug, reduced to its smallest form.
  const pts = normalizeDailySeries([
    day('2026-08-01', { maxPricePerHour: 3.39 }),
    day('2026-08-02', { maxPricePerHour: 3.45 }),
  ]);
  const h = periodHeadline(pts);
  assert.equal(h.priceBasis, BASIS_MEDIAN);
  assert.equal(h.headlinePricePerHour, 3.42);
  assert.equal(h.basisDayCounts.median, 2);
  assert.notEqual(h.headlinePricePerHour, null, 'August must not render blank');
});

test('a straddle month keeps the majority measure and excludes the rest', () => {
  // July 2026 in miniature: three floor days, one median day. The old rule
  // ("prefer any median") would have labelled the single median day a month.
  const pts = normalizeDailySeries([
    day('2026-07-25', { minPricePerHour: 0.40, maxPricePerHour: 14.9, priceMidpoint: 7.65, spreadMultiple: 37.3 }),
    day('2026-07-26', { minPricePerHour: 0.50, maxPricePerHour: 14.9, priceMidpoint: 7.70, spreadMultiple: 29.8 }),
    day('2026-07-27', { minPricePerHour: 0.60, maxPricePerHour: 14.9, priceMidpoint: 7.75, spreadMultiple: 24.8 }),
    day('2026-07-28', { maxPricePerHour: 3.00 }),
  ]);
  const h = periodHeadline(pts);
  assert.equal(h.priceBasis, BASIS_FLOOR, 'majority of priced days are floor days');
  assert.equal(h.headlinePricePerHour, 0.5, 'the median day must not drag the floor average');
  assert.equal(h.mixedBasis, true);
  assert.equal(h.basisDaysUsed, 3);
  assert.deepEqual(h.basisDayCounts, { median: 1, floor: 3 });
  // The number that proves the market did not jump.
  assert.equal(h.alternateBasis, BASIS_MEDIAN);
  assert.equal(h.alternatePricePerHour, 3.0);
});

test('a tie goes to the measure the source publishes going forward', () => {
  const pts = normalizeDailySeries([
    day('2026-07-27', { minPricePerHour: 0.4, maxPricePerHour: 14.9, priceMidpoint: 7.65, spreadMultiple: 37.3 }),
    day('2026-07-28', { maxPricePerHour: 3.0 }),
  ]);
  assert.equal(periodHeadline(pts).priceBasis, BASIS_MEDIAN);
});

test('an unpriced period reports no basis rather than guessing one', () => {
  const h = periodHeadline(normalizeDailySeries([day('2026-08-01'), day('2026-08-02')]));
  assert.equal(h.headlinePricePerHour, null);
  assert.equal(h.priceBasis, null);
  assert.equal(h.mixedBasis, false);
});

test('coverage counts only the days the headline rests on', () => {
  const pts = normalizeDailySeries([
    day('2026-07-26', { minPricePerHour: 0.5, maxPricePerHour: 14.9, priceMidpoint: 7.7, spreadMultiple: 29.8 }),
    day('2026-07-27', { minPricePerHour: 0.6, maxPricePerHour: 14.9, priceMidpoint: 7.75, spreadMultiple: 24.8 }),
    day('2026-07-28', { maxPricePerHour: 3.0 }),
  ]);
  assert.equal(pricedDatesForBasis(pts, BASIS_FLOOR).size, 2);
  assert.equal(pricedDatesForBasis(pts, BASIS_MEDIAN).size, 1);
});

test('duplicate captures on one date count once', () => {
  const pts = normalizeDailySeries([
    day('2026-08-01', { maxPricePerHour: 3.0 }),
    day('2026-08-01', { maxPricePerHour: 3.0 }),
  ]);
  assert.equal(periodHeadline(pts).basisDayCounts.median, 1);
});

/* ── Growth: the refusal that stops the phantom jump ──────────────────── */

const JUL = { priceBasis: BASIS_FLOOR, headlinePricePerHour: 0.4027, label: 'Jul-26' };
const AUG = { priceBasis: BASIS_MEDIAN, headlinePricePerHour: 3.4186, label: 'Aug-26' };
const SEP = { priceBasis: BASIS_MEDIAN, headlinePricePerHour: 3.3445, label: 'Sep-26' };

test('growth across the measure change is refused, not reported as +749%', () => {
  assert.equal(periodGrowth(AUG, JUL), null);
  // Sanity check on the number we are refusing to print.
  assert.ok(pctChange(AUG.headlinePricePerHour, JUL.headlinePricePerHour) > 700);
});

test('growth within one measure is computed — August to September is a small fall', () => {
  const g = periodGrowth(SEP, AUG);
  assert.ok(g < 0 && g > -5, 'expected a low-single-digit decline, got ' + g);
  assert.equal(g, -2.17);
});

test('the refusal carries an explanation naming both measures', () => {
  const why = growthRefusalReason(AUG, JUL, 'Jul-26');
  assert.match(why, /Not comparable/);
  assert.match(why, /Jul-26/);
  assert.match(why, /floor/);
  assert.match(why, /median/);
  assert.match(why, /not a price move/);
});

test('a missing prior period is explained differently from a measure change', () => {
  const why = growthRefusalReason(SEP, null, 'Aug-26');
  assert.match(why, /No price captured for Aug-26/);
  assert.doesNotMatch(why, /Not comparable/);
});

test('growth against a zero prior is refused rather than returning Infinity', () => {
  assert.equal(periodGrowth(SEP, { priceBasis: BASIS_MEDIAN, headlinePricePerHour: 0 }), null);
});

/* ── Change detection ─────────────────────────────────────────────────── */

test('the timeline finds the 2026-07-28 boundary from the data alone', () => {
  const series = {
    'Nvidia H100': normalizeDailySeries([
      day('2026-07-26', { minPricePerHour: 0.5, maxPricePerHour: 14.9, priceMidpoint: 7.7, spreadMultiple: 29.8 }),
      day('2026-07-27', { minPricePerHour: 0.6, maxPricePerHour: 14.9, priceMidpoint: 7.75, spreadMultiple: 24.8 }),
      day('2026-07-28', { maxPricePerHour: 2.97 }),
      day('2026-08-01', { maxPricePerHour: 3.39 }),
      day('2026-09-16', { medianPricePerHour: 3.3819 }),
    ]),
  };
  const t = detectBasisTimeline(series);
  assert.equal(t.currentBasis, BASIS_MEDIAN);
  assert.equal(t.changes.length, 1, 'era 2 and era 3 are the same measure — one change, not two');
  assert.equal(t.changes[0].effectiveDate, '2026-07-28');
  assert.equal(t.changes[0].previousDate, '2026-07-27');
  assert.equal(t.changes[0].from, BASIS_FLOOR);
  assert.equal(t.changes[0].to, BASIS_MEDIAN);
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[0].days, 2);
  assert.equal(t.segments[1].days, 3);
});

test('a history with one measure throughout reports no change', () => {
  const t = detectBasisTimeline({
    'Nvidia H100': normalizeDailySeries([
      day('2026-09-15', { medianPricePerHour: 3.2 }),
      day('2026-09-16', { medianPricePerHour: 3.3 }),
    ]),
  });
  assert.equal(t.changes.length, 0);
  assert.equal(t.currentBasis, BASIS_MEDIAN);
});

test('the period boundary lands between the last floor month and the first median month', () => {
  const recs = {
    'Nvidia H100': [
      { period: '2026-06', priceBasis: BASIS_FLOOR },
      { period: '2026-07', priceBasis: BASIS_FLOOR, mixedBasis: true },
      { period: '2026-08', priceBasis: BASIS_MEDIAN },
      { period: '2026-09', priceBasis: BASIS_MEDIAN },
    ],
  };
  const b = basisChangeForPeriods(recs, ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(b.boundaries, [
    { boundaryBefore: '2026-07', boundaryAfter: '2026-08', from: BASIS_FLOOR, to: BASIS_MEDIAN },
  ]);
  assert.deepEqual(b.mixedPeriods, ['2026-07']);
  assert.equal(b.basisByPeriod['2026-07'], BASIS_FLOOR);
});

test('a period whose SKUs disagree on the measure is flagged rather than picked', () => {
  const b = basisChangeForPeriods({
    'Nvidia H100': [{ period: '2026-07', priceBasis: BASIS_FLOOR }],
    'Nvidia A100': [{ period: '2026-07', priceBasis: BASIS_MEDIAN }],
  }, ['2026-07']);
  assert.equal(b.basisByPeriod['2026-07'], 'mixed');
});

/* ── The whole scenario, end to end ───────────────────────────────────── */

test('the reported Apr→Sep H100 history contains no fabricated jump', () => {
  // Real monthly figures for Nvidia H100 from the live feed.
  const months = {
    '2026-04': periodHeadline(normalizeDailySeries([day('2026-04-21', { minPricePerHour: 0.5394, maxPricePerHour: 14.9, priceMidpoint: 7.72, spreadMultiple: 27.6 })])),
    // Real July: 27 days of range captures, then 4 days on the new measure
    // after the source switched on the 28th. The floor days are the majority,
    // so July stays a floor month and keeps the median days as its alternate.
    '2026-07': periodHeadline(normalizeDailySeries([
      ...Array.from({ length: 27 }, (_, i) =>
        day('2026-07-' + String(i + 1).padStart(2, '0'),
            { minPricePerHour: 0.4027, maxPricePerHour: 14.9, priceMidpoint: 7.65, spreadMultiple: 37 })),
      ...['28', '29', '30', '31'].map(d => day('2026-07-' + d, { maxPricePerHour: 2.97 })),
    ])),
    '2026-08': periodHeadline(normalizeDailySeries([day('2026-08-01', { maxPricePerHour: 3.4186 })])),
    '2026-09': periodHeadline(normalizeDailySeries([day('2026-09-16', { medianPricePerHour: 3.3445 })])),
  };

  // 1. August is no longer blank.
  assert.equal(months['2026-08'].headlinePricePerHour, 3.4186);
  assert.equal(months['2026-08'].priceBasis, BASIS_MEDIAN);

  // 2. No growth cell anywhere reports the phantom jump.
  const ids = ['2026-04', '2026-07', '2026-08', '2026-09'];
  for (let i = 1; i < ids.length; i++) {
    const g = periodGrowth(months[ids[i]], months[ids[i - 1]]);
    assert.ok(g == null || Math.abs(g) < 100,
      ids[i - 1] + '→' + ids[i] + ' reported ' + g + '% — a measure change leaked into growth');
  }

  // 3. The one comparison that IS valid shows the market roughly flat.
  const augToSep = periodGrowth(months['2026-09'], months['2026-08']);
  assert.ok(Math.abs(augToSep) < 5, 'Aug→Sep should be a small move, got ' + augToSep);

  // 4. July still carries the evidence that nothing jumped: its own days on
  //    the new measure sat next to August's, not five times below.
  assert.equal(months['2026-07'].alternatePricePerHour, 2.97);
  const likeForLike = pctChange(months['2026-08'].headlinePricePerHour, months['2026-07'].alternatePricePerHour);
  assert.ok(Math.abs(likeForLike) < 20, 'like-for-like Jul→Aug should be modest, got ' + likeForLike);
});
