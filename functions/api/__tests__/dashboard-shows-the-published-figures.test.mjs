/**
 * The screen must show the figures the API now publishes, each with its
 * caveat in words — and every marker it draws must ship with its legend.
 *
 * Four server changes made this dashboard able to print numbers it used to
 * blank, and changed what one of them MEANS:
 *
 *   1. A like-for-like model-price change resting on under half the lineup is
 *      published and marked (<key>LowMatchedShare) with <key>MatchedModels /
 *      <key>LineupModels, instead of being refused into a dash.
 *   2. Where no usage weights exist at all, a weighted cell shows its own list
 *      price, declared as such (estimateDeclared / estimateMarker), with
 *      weighting.unweightedFallbackReason to say so once over the table.
 *   3. A GPU growth cell spanning the 2026-07-28 change of measure is restated
 *      onto the measure both periods share and carries a note naming the days
 *      it rests on (monthly.momNote / quarterly.qoqNote / both yoyNote).
 *   4. A supply signal off a stretched comparator is classified rather than
 *      blanked, and signalBasis[sku].label names the span ("loosening · 26d").
 *
 * A published field the page does not read is the same to the reader as a
 * withheld one, so each of these is pinned here.
 *
 * The legend half is pinned because this repo has been burned by exactly that
 * split: a caption was removed while its dagger stayed, leaving a symbol on
 * screen with no key (see functions/__tests__/dashboard-references.test.mjs
 * for the sibling failure). Every marker introduced below is asserted to have
 * its legend in the same component that can draw it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = readFileSync(resolve(ROOT, 'js/dashboard.jsx'), 'utf8').replace(/\r\n/g, '\n');

/** The body of a top-level `function NAME(` declaration, braces balanced. */
function fnSource(name) {
  const head = SRC.indexOf('\nfunction ' + name + '(');
  assert.ok(head >= 0, name + ' is gone from js/dashboard.jsx; move this guard with it');
  let k = SRC.indexOf('(', head), parens = 0;
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') parens++;
    else if (SRC[k] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let j = SRC.indexOf('{', k); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(head + 1, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// Comments say what the code should do; only the code does it. Every
// assertion below runs against the stripped form so a comment mentioning a
// field cannot stand in for reading it.
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const MATRIX = code(fnSource('ModelPricingHistoryBlock'));
const FIN = code(fnSource('GPUFinancialCorrelationBlock'));
const FIN_ROWS = code(fnSource('renderFinGrowthRows'));
const GPU_HIST = code(fnSource('GPUHistoryBlock'));
const SHARE = code(fnSource('PricingShareSignalBlock'));
const SHARE_PARTIAL = code(fnSource('PricingSharePartialView'));

/* ── 1. A thin like-for-like change: shown, counted, weakened ─────────────── */

test('a change resting on under half the lineup is read from the cell, not ignored', () => {
  assert.match(MATRIX, /qoqLowMatchedShare/,
    'the QoQ thin-match mark is published per cell and never read');
  assert.match(MATRIX, /yoyLowMatchedShare/,
    'the YoY thin-match mark is published per cell and never read');
  assert.match(MATRIX, /qoqLineupModels/,
    'the lineup count is published beside the matched count and never read');
  assert.match(MATRIX, /yoyLineupModels/,
    'the lineup count is published beside the matched count and never read');
});

test('a thin change says what it rests on: "N of M models like-for-like"', () => {
  assert.match(MATRIX, /of "\+ofLineup\+" models like-for-like/,
    'a thin change must name the matched set against the lineup, not just the matched count');
});

test('a thin change is weakened on screen rather than printed as firmly as a full one', () => {
  assert.match(MATRIX, /fontWeight:thinMatch\?400:600/,
    'the number is correct but speaks for part of the lineup; it must not carry the ' +
    'same weight as a change measured across all of it');
});

test('the lighter type has a legend in the same block that draws it', () => {
  assert.match(MATRIX, /lighter type/,
    'a weakened cell with no key is a presentation the reader cannot decode');
  assert.match(MATRIX, /models like-for-like/,
    'the legend must quote the sub-label it is explaining');
});

/* ── 2. The list-price fallback: marked, with its legend over the table ───── */

test('a declared list-price cell is marked as one, not dressed as an estimate', () => {
  assert.match(MATRIX, /estimateDeclared/,
    'a ratio of 1.00 by declaration is not an inferred estimate and must not read as one');
  assert.match(MATRIX, /estimateMarker/,
    "the server's own words for the marker are published and must be the ones shown");
});

test('the unweighted fallback is stated once over the table', () => {
  assert.match(MATRIX, /unweightedFallback/,
    'with no weights anywhere the whole view is unweighted; the page must say so');
  assert.match(MATRIX, /unweightedFallbackReason/,
    "the reason is published in words and must be shown, not replaced by the page's own guess");
});

/* ── 3. GPU growth restated across the change of measure ─────────────────── */

test('the restatement notes are read from the response', () => {
  assert.match(FIN, /momNote/, 'monthly.momNote is published and never read');
  assert.match(FIN, /qoqNote/, 'quarterly.qoqNote is published and never read');
  assert.match(FIN, /yoyNote/, 'both yoyNote maps are published and never read');
});

test('every growth row is handed its notes, YoY included', () => {
  const calls = FIN.match(/renderFinGrowthRows\([^\n]*\)/g) || [];
  assert.equal(calls.length, 4, 'expected the four growth-row renders (QoQ/MoM and YoY, primary and secondary)');
  for (const c of calls) {
    assert.match(c, /Notes/,
      'a growth row rendered without its notes prints a restated figure with nothing ' +
      'saying it was restated: ' + c);
  }
});

test('a restated cell prints its figure with a marker and the note on hover', () => {
  assert.match(FIN_ROWS, /const row_n=/, 'the per-SKU note map is not resolved');
  assert.match(FIN_ROWS, /const restated=/, 'no cell knows whether its figure was restated');
  assert.match(FIN_ROWS, /restated&&<sup/, 'a restated figure is printed with no marker at all');
  assert.match(FIN_ROWS, /restated\?" · "\+restated/,
    'the note names the days each side rests on and must reach the tooltip');
});

test('the double-dagger has its legend in the methodology under the same table', () => {
  assert.match(FIN_ROWS, /&Dagger;/, 'the marker is gone from the cell');
  assert.match(FIN, /&Dagger;/,
    'the marker is drawn with no key under the table — the exact split this repo ' +
    'has already shipped once with the post-change dagger');
});

/* ── 4. The supply signal's named span ───────────────────────────────────── */

test('the signal badge is drawn from signalBasis, so it names its span', () => {
  assert.match(GPU_HIST, /signalBasis/,
    'signalBasis is published and never read, so the badge still claims 7 days');
  assert.match(GPU_HIST, /sb&&sb\.label/,
    "the server's read-aloud label ('loosening · 26d') must be the badge's text");
  assert.match(GPU_HIST, /sb&&sb\.reason/,
    'the reason names the span, the dates and the measure, and belongs on the badge');
});

test('a card with no 7-day figure still carries its signal badge', () => {
  // The stretched-window card returns early. The badge used to be computed
  // after that return, so precisely the case the server now classifies was the
  // one card that showed nothing.
  const refusal = GPU_HIST.slice(GPU_HIST.indexOf('const why=dailyDeltaRefusal(c,7,true);'),
                                 GPU_HIST.indexOf('const pct=c.priceDeltaPct;'));
  assert.ok(refusal.length > 0, 'the refusal branch moved; move this guard with it');
  assert.match(refusal, /\{sigBadge\}/,
    'the classification exists for this card and is not shown on it');
  assert.ok(GPU_HIST.indexOf('const sigBadge=') < GPU_HIST.indexOf('const why=dailyDeltaRefusal(c,7,true);'),
    'the badge must be computed before the refusal branch returns, or that branch cannot draw it');
});

test('the span suffix has a legend, and a signal off a stretched span is not labelled 7D', () => {
  assert.match(GPU_HIST, /windowStretched&&signalBasis\[sku\]\.label/,
    'the legend for the "· Nd" suffix does not mount on the condition that draws it');
  assert.doesNotMatch(GPU_HIST, /Signal \(7D\):/,
    'the summary strip fixes the heading at 7D while a stretched comparator can now ' +
    'reach it — a 26-day move printed under "Signal (7D)" is a mislabel');
  assert.match(GPU_HIST, /spanTag/, 'a message off a span other than 7 days must carry it');
});

/* ── 5. The share measure is named where the share figures are ───────────── */

test('the measure is named above the figures, in both share views', () => {
  assert.match(SRC, /function ShareMeasureStrip\(/,
    'nothing states the measure alongside the numbers; the foot-of-block caveat ' +
    'strip is the only place it appears');
  assert.match(SHARE, /<ShareMeasureStrip basis=\{d\.shareBasis\}\/>/,
    'the full view shows share levels and share QoQ without naming the measure');
  assert.match(SHARE_PARTIAL, /<ShareMeasureStrip basis=\{basis\}\/>/,
    'the partial view shows share levels without naming the measure');
});

test('the strip names the change of measure, not just the current one', () => {
  const STRIP = code(fnSource('ShareMeasureStrip'));
  assert.match(STRIP, /measureLabel/, 'the measure must come from the server');
  assert.match(STRIP, /provider-weekly/,
    'on the weekly series the reader must be told this is a different measure from ' +
    'the one the block read before — an unlabelled switch is worse than the break it fixed');
  assert.match(STRIP, /100%/,
    'levels no longer sum to 100% and are lower than the top-N figures; saying so is ' +
    'the difference between a redefinition and a silent one');
});

test('a callout naming a share level says what it is a share of', () => {
  assert.match(SRC, /function shareOfPhrase\(/, 'the phrase helper is gone');
  assert.match(SHARE_PARTIAL, /shareOfPhrase\(basis\)/,
    'the largest-share callout described "the top N models\' tokens" from basis.depth, ' +
    'which is null on the weekly measure — so it fell back to the word "ranked", ' +
    'which names no measure at all');
});

test('a provider absent from a quarter is explained on the measure in force', () => {
  assert.match(SHARE, /const absentFrom=/,
    'the absence sentence is fixed to the daily top-N measure');
  assert.match(SHARE, /others/,
    'on the weekly series a provider it does not name is inside the "others" remainder — ' +
    'unknown, not zero — and saying "no model in the top N on any counted day" ' +
    'describes a measure the block is not reading');
  assert.doesNotMatch(SHARE, /no model in \{topN\} on any of the/,
    'the daily-only wording is back in the JSX');
});

test('the share columns name their measure where the reader meets the numbers', () => {
  assert.match(SHARE, /h\.startsWith\("Share"\)\?\(\(d\.shareBasis&&d\.shareBasis\.measureNote\)/,
    'the Share QoQ column heads a column of figures whose meaning changed, unlabelled');
  assert.match(SHARE_PARTIAL, /h==="Current Share"\?\(\(basis&&basis\.measureNote\)/,
    'the Current Share column heads a column of figures whose meaning changed, unlabelled');
});

/* ── 6. The other half: the API still publishes what the page now reads ──── */

test('the endpoints still publish every field this page now depends on', () => {
  const matrix = readFileSync(resolve(ROOT, 'functions/api/provider-pricing-matrix.js'), 'utf8');
  for (const f of ['LowMatchedShare', 'LineupModels', 'MatchedModels',
                   'estimateDeclared', 'estimateMarker', 'unweightedFallback',
                   'unweightedFallbackReason']) {
    assert.ok(matrix.includes(f), 'provider-pricing-matrix.js no longer publishes ' + f);
  }
  const gpu = readFileSync(resolve(ROOT, 'functions/api/gpu-hardware-pricing-history.js'), 'utf8');
  for (const f of ['momNote', 'qoqNote', 'yoyMonthNote', 'yoyQuarterNote', 'signalBasis']) {
    assert.ok(gpu.includes(f), 'gpu-hardware-pricing-history.js no longer publishes ' + f);
  }
  const share = readFileSync(resolve(ROOT, 'functions/api/pricing-share-signal.js'), 'utf8');
  for (const f of ['measureLabel', 'measureNote', 'provider-weekly']) {
    assert.ok(share.includes(f), 'pricing-share-signal.js no longer publishes ' + f);
  }
});
