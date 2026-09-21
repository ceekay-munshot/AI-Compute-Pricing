/**
 * The GPU price resilience signal has one rule, and both places that show it
 * use it.
 *
 * The bug: GPU → Financial Correlation moved to three states (Stable/up ·
 * Mixed · Falling, over a 2M or 2Q look-back) while the Excel export kept the
 * old binary, so every period whose two growth readings disagreed read
 * "Mixed" on screen and "Falling" in the download. B200 read "Falling" at
 * +2.0% because the month before it was -0.9%.
 *
 * The rule now lives in js/gpu-resilience.js. These tests pin the rule, pin
 * that the workbook's cells come from it, and fail if either surface grows its
 * own copy again. The table itself is JSX and cannot run here, so its half of
 * the guard reads the source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resilienceSignal, resilienceSpan, LOW_PRICED_COVERAGE } from '../../../js/gpu-resilience.js';
import { buildGPUPricingWorkbook } from '../../../js/gpu-xlsx-report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// A completed, fully priced period on one measure. Each test overrides only
// what it is about.
const graded = (over = {}) => ({
  captured: true,
  priced: true,
  inProgress: false,
  bases: ['median', 'median', 'median'],
  growth: 1,
  priorGrowth: 1,
  coverage: 1,
  priorCoverage: 1,
  quarterly: false,
  ...over,
});

/* ─── The rule ─────────────────────────────────────────────────────────── */

test('held or rose twice is Stable/up, in the unit of the axis', () => {
  assert.deepEqual(resilienceSignal(graded({ growth: 2, priorGrowth: 0 })),
    { state: 'stable', label: 'Stable/up 2M', thin: false });
  assert.equal(resilienceSignal(graded({ quarterly: true })).label, 'Stable/up 2Q');
  assert.equal(resilienceSpan(false), '2M');
  assert.equal(resilienceSpan(true), '2Q');
});

test('fell twice is Falling, in the unit of the axis', () => {
  assert.equal(resilienceSignal(graded({ growth: -1, priorGrowth: -3 })).label, 'Falling 2M');
  assert.equal(resilienceSignal(graded({ growth: -1, priorGrowth: -3, quarterly: true })).label, 'Falling 2Q');
});

test('one reading up and one down is Mixed, never Falling', () => {
  // B200: +2.0% after a -0.9% month. The old binary said "Falling".
  const b200 = resilienceSignal(graded({ growth: 2.0, priorGrowth: -0.9 }));
  assert.equal(b200.state, 'mixed');
  assert.equal(b200.label, 'Mixed');
  assert.equal(resilienceSignal(graded({ growth: -2.0, priorGrowth: 0.9, quarterly: true })).label, 'Mixed');
});

test('an ungraded period says why, checked in the documented order', () => {
  assert.equal(resilienceSignal(graded({ captured: false, priced: false })).state, 'no-capture');
  assert.equal(resilienceSignal(graded({ priced: false })).state, 'no-price');
  assert.equal(resilienceSignal(graded({ inProgress: true, growth: null })).state, 'in-progress');
  // Refused on the measures alone, even if both growth readings were present.
  assert.deepEqual(resilienceSignal(graded({ bases: ['median', 'median', 'floor'] })),
    { state: 'measure-changed', bases: ['median', 'median', 'floor'] });
  assert.equal(resilienceSignal(graded({ bases: ['median', 'floor', 'floor'], growth: null })).state, 'measure-changed');
  assert.equal(resilienceSignal(graded({ priorGrowth: null })).state, 'no-lookback');
  assert.equal(resilienceSignal(graded({ growth: undefined })).state, 'no-lookback');
  assert.equal(resilienceSignal(graded({ growth: NaN })).state, 'no-lookback');
});

test('a reading resting on a thinly priced period is marked, on either side', () => {
  assert.equal(resilienceSignal(graded({ coverage: 0.5 })).thin, true);
  assert.equal(resilienceSignal(graded({ priorCoverage: 0.74 })).thin, true);
  assert.equal(resilienceSignal(graded({ coverage: LOW_PRICED_COVERAGE, priorCoverage: null })).thin, false);
});

/* ─── The workbook writes what the rule says ───────────────────────────── */

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const QUARTERS = ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3'];

function rec(period, over = {}) {
  return {
    period,
    hasPrice: true,
    headlinePricePerHour: 3,
    priceBasis: 'median',
    pricedCoverageRatioWithinMonth: 1,
    ...over,
  };
}

const SKUS = [
  { sku: 'B200', shortLabel: 'B200' },
  { sku: 'H100', shortLabel: 'H100' },
  { sku: 'A100', shortLabel: 'A100' },
  { sku: 'L40S', shortLabel: 'L40S' },
];

// Growth arrives in percent, as the API sends it.
const fHist = {
  trackingSinceRealDate: '2026-04-21',
  dataQuality: {},
  monthly: {
    labels: MONTHS.map((p) => ({ period: p, label: p, isMTD: p === '2026-09' })),
    series: {
      B200: MONTHS.map((p) => rec(p, p === '2026-09' ? { isMTD: true } : {})),
      H100: MONTHS.map((p) => rec(p, p === '2026-08' ? { pricedCoverageRatioWithinMonth: 0.5 } : {})),
      // Measured as a floor through May, as a median from June.
      A100: MONTHS.map((p) => rec(p, p <= '2026-05' ? { priceBasis: 'floor' } : {})),
      // No capture in June, and a capture with no price in July.
      L40S: MONTHS.filter((p) => p !== '2026-06').map((p) =>
        rec(p, p === '2026-07' ? { hasPrice: false, headlinePricePerHour: null, priceBasis: null } : {})),
    },
    mom: {
      B200: { '2026-05': -0.9, '2026-06': 2.0, '2026-07': -1.5, '2026-08': -0.4 },
      H100: { '2026-05': 1, '2026-06': 0, '2026-07': 2, '2026-08': 3 },
      A100: { '2026-05': 1, '2026-06': null, '2026-07': 1, '2026-08': 1 },
      L40S: { '2026-05': 1 },
    },
    yoy: {},
  },
  quarterly: {
    labels: QUARTERS.map((p) => ({ period: p, label: p, isQTD: p === '2026-Q3' })),
    series: {
      B200: QUARTERS.map((p) => rec(p)),
      H100: QUARTERS.map((p) => rec(p)),
    },
    qoq: {
      B200: { '2026-Q1': 1, '2026-Q2': 2 },
      H100: { '2026-Q1': -1, '2026-Q2': -2 },
    },
    yoy: {},
  },
};

// The resilience block of one growth sheet: its note and each SKU's cells.
function resilienceBlock(wb, sheetName) {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  assert.ok(sheet, 'no sheet named ' + sheetName);
  const at = sheet.rows.findIndex((r) => r[0] && r[0].v === 'Price resilience signal');
  assert.ok(at >= 0, 'no resilience block on ' + sheetName);
  const cells = {};
  for (const r of sheet.rows.slice(at + 3)) {
    if (!r.length) break;
    cells[r[0].v] = r.slice(1).map((c) => c.v);
  }
  return { note: sheet.rows[at + 1][0].v, cells };
}

test('the monthly sheet grades each period exactly as the rule does', () => {
  const { cells } = resilienceBlock(buildGPUPricingWorkbook(fHist, null, SKUS), 'MoM growth');
  //                          Apr May Jun      Jul      Aug           Sep
  assert.deepEqual(cells.B200, ['', '', 'Mixed', 'Mixed', 'Falling 2M', 'in progress']);
  assert.deepEqual(cells.H100, ['', '', 'Stable/up 2M', 'Stable/up 2M', 'Stable/up 2M °', 'in progress']);
  assert.deepEqual(cells.A100, ['', '', 'measure changed', 'measure changed', 'Stable/up 2M', 'in progress']);
  assert.deepEqual(cells.L40S, ['', '', 'no capture', 'no price', '', 'in progress']);
});

test('no workbook cell reads the old bare "Stable/up" or "Falling"', () => {
  const wb = buildGPUPricingWorkbook(fHist, null, SKUS);
  for (const name of ['MoM growth', 'QoQ growth']) {
    for (const row of Object.values(resilienceBlock(wb, name).cells)) {
      for (const v of row) assert.ok(!/^(Stable\/up|Falling)( °)?$/.test(v), name + ' wrote "' + v + '"');
    }
  }
});

test('the quarterly sheet uses the quarter unit, in its cells and its note', () => {
  const { cells, note } = resilienceBlock(buildGPUPricingWorkbook(fHist, null, SKUS), 'QoQ growth');
  assert.deepEqual(cells.B200, ['', '', 'Stable/up 2Q', 'in progress']);
  assert.deepEqual(cells.H100, ['', '', 'Falling 2Q', 'in progress']);
  assert.match(note, /"Stable\/up 2Q"/);
  assert.match(note, /"Falling 2Q"/);
  assert.match(note, /"Mixed"/);
  assert.match(note, /completed quarters/);
});

test('the monthly note names all three states with the month unit', () => {
  const { note } = resilienceBlock(buildGPUPricingWorkbook(fHist, null, SKUS), 'MoM growth');
  assert.match(note, /"Stable\/up 2M"/);
  assert.match(note, /"Falling 2M"/);
  assert.match(note, /"Mixed"/);
  assert.match(note, /completed months/);
  assert.doesNotMatch(note, /it did not/, 'the note still describes the old binary');
});

/* ─── Neither surface carries its own copy ─────────────────────────────── */

test('the dashboard table renders the shared rule and grades nothing itself', () => {
  const src = source('js/dashboard.jsx');
  assert.match(src, /import\s*\{[^}]*\bresilienceSignal\b[^}]*\}\s*from\s*"\.\/gpu-resilience\.js"/);
  const start = src.indexOf('function renderFinResilienceRows(');
  assert.ok(start >= 0, 'renderFinResilienceRows is gone; move this guard with it');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /resilienceSignal\(/);
  assert.doesNotMatch(body, /"Stable\/up|"Falling|"Mixed"/, 'the table spells out its own labels again');
  assert.doesNotMatch(body, />=\s*0\s*&&|<\s*0\s*&&/, 'the table compares growth against zero itself again');
  assert.match(src, /const FIN_LOW_COVERAGE=LOW_PRICED_COVERAGE;/);
});

test('the workbook carries no copy of the rule either', () => {
  const src = source('js/gpu-xlsx-report.js');
  assert.match(src, /import\s*\{[^}]*\bresilienceSignal\b[^}]*\}\s*from\s*"\.\/gpu-resilience\.js"/);
  assert.doesNotMatch(src, />=\s*0\s*&&/, 'the workbook compares growth against zero itself again');
  assert.doesNotMatch(src, /LOW_COVERAGE\s*=\s*0\.\d/, 'the workbook has its own thin-coverage threshold again');
});
