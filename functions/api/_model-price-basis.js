/**
 * Model price basis — every read of a model price, detection of the days the
 * source changed WHAT it reports, and the refusal of growth across them.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every model-pricing figure on the dashboard comes from pricepertoken's
 * per-model daily history. On 2026-07-10 the reported price of 13 Google and
 * 10 OpenAI models fell on the same day, every one of them to EXACTLY half of
 * its previous figure. Gemini 2.5 Pro had read $1.25 per 1M input tokens for a
 * year and read $0.625 from that morning; GPT-5 mini went from $0.25 to
 * $0.125. Two unrelated vendors do not reprice two dozen models by one
 * identical factor on one day. That is the source changing which price it
 * reports — a change of measure, not a market repricing.
 *
 * The dashboard reported it as one: "Biggest price cut: Google -19.5%" for
 * 2026-Q3, OpenAI -11.9% QoQ, -35% month-on-month in July on the touched
 * peer-matrix rows and a further -22.5% in August (July's average blended
 * both measures, so August "fell" from the blend), and -50% YoY. Those are
 * exactly the numbers a customer escalates, and none of them happened in the
 * market.
 *
 * Why not read the rows' original_* fields instead? They never move. For every
 * Google model across the whole history they hold the model's first captured
 * price — a fixed reference the source's own percentage columns are computed
 * against, not a live list price. Reading them would flatten every price line
 * and erase the real repricings along with the artefact.
 *
 * This module is modelled on _gpu-price-basis.js, which solves the same
 * problem for the GPU feed's 2026-07-28 change: find the change from the data,
 * tag every observation with the measure it sits on, average each period on
 * one measure, and refuse growth between periods on different measures.
 *
 * HOW A CHANGE OF MEASURE IS TOLD APART FROM A REAL PRICE CUT
 * ────────────────────────────────────────────────────────────
 * A single model's step proves nothing. A model halving its price on its own
 * is an ordinary price cut, and the history has real ones: Gemini 3.6 Flash
 * halved alone on 2026-08-14, GPT-5 halved for a week in September 2025. What
 * marks a change of measure is the DAY, not the model:
 *
 *   - at least MIN_EVENT_MODELS standard SKUs step by exactly one factor
 *     (x0.5, or x2) on the same date, all in the same direction, and
 *   - at every provider counted, those exact steps are at least
 *     MIN_EVENT_EXACT_SHARE of that provider's own price moves that day.
 *
 * The share is judged per provider, never across the whole request: an
 * unrelated provider repricing on the same day says nothing about what the
 * source did to Google's rows, and a request-wide share would make the verdict
 * depend on which providers happened to be fetched (the pricing matrix reads
 * eight, the peer matrix three).
 *
 * 2026-07-10 clears both by a wide margin: 13 of 13 Google moves and 10 of 11
 * OpenAI moves are exact halvings. Nothing else in the Google, OpenAI or
 * Anthropic history comes close — the next-largest cluster is four new OpenAI
 * SKUs on 2026-07-28, and a day with mixed directions (2026-08-18: four
 * doublings and two halvings inside one new product family) is a repricing,
 * not a switch of measure.
 *
 * Only once a DATE qualifies is any model examined, and a model is touched by
 * the change only if its OWN price stepped by that exact factor, in that
 * direction, across that date. Models priced straight through the date without
 * moving (GPT-5, GPT-4o, every Gemma, all of Anthropic) are untouched and
 * compare normally on both sides.
 *
 * A model first listed ON or AFTER the date, at a provider the change touched,
 * is placed on the new measure from its first day. It has no earlier price
 * to prove otherwise, and the source reports it the way it now reports that
 * provider — GPT-5.6 Sol, listed on the day of the change, must not be
 * compared with GPT-5.5 Pro's pre-change figure as if the two were the same
 * measure (that comparison read -91.7%). At a provider the change never
 * touched (Anthropic), a new model is simply untouched.
 *
 * The date is DETECTED, not hard-coded — no constant in this module holds
 * 2026-07-10, and the tests find it from fixture rows alone. One
 * vendor's rows are enough to find it (Google alone shows 13 of 13 moves
 * exact that day; OpenAI alone 10 of 11), so a response in which the other
 * provider failed to load still refuses the comparison rather than quietly
 * printing the phantom cut. The same rule would find the next such change with
 * no code change.
 *
 * A touched model that later steps back by the exact inverse factor, onto
 * exactly the figure it carried before the change, has gone back to the old
 * measure (Gemini 3.1 Flash Image Preview: $0.50, $0.25 on 2026-07-10, $0.50
 * again on 2026-07-27). Reporting that as a +100% price rise would be the same
 * artefact in reverse, so it is treated as a return to the earlier measure and
 * growth across it is refused as well.
 *
 * WHAT HAPPENS TO THE NUMBERS
 * ───────────────────────────
 *   Levels   A period's average rests on ONE measure. Where a period straddles
 *            a change, the measure holding most of the touched models'
 *            observations wins — ties go to the newer one, which is what the
 *            source publishes going forward — and the rest are left out and
 *            counted, never blended: a blend of $1.25 and $0.625 describes
 *            nothing. Untouched models always count. Nothing is rescaled: a
 *            figure after the change is exactly what the source now reports.
 *   Growth   QoQ, MoM and YoY between periods on different measures are
 *            LINKED: a model the change moved is compared at its reported
 *            price times the inverse of the exact factor the change applied
 *            to it (x2 for 2026-07-10), which is its figure on the earlier
 *            measure to the cent — the step was detected as exact. Each
 *            observation carries that link (linkOf), each period its
 *            earlier-measure level (`linked`), and growth across the change
 *            is taken between those. A model first listed after the change
 *            has no earlier figure to link to, so a period resting on one
 *            still refuses growth across the change, with a reason. Within
 *            one side growth is computed exactly as before.
 *
 * This is a read-time classification of the rows as received. Nothing is
 * stored or rewritten anywhere.
 */

export const METRIC_FIELD = Object.freeze({
  input: 'pricing_prompt',
  output: 'pricing_completion',
});

// The measure every observation is on until a change touches its model.
export const BASIS_ORIGIN = 'origin';

// Relative tolerance on "exactly x0.5 / x2". Upstream prices are short
// decimals in $/token, so a real halving is exact to floating-point noise; a
// 1e-6 band admits that noise and nothing a market would ever price.
export const EXACT_RATIO_TOLERANCE = 1e-6;

// A date qualifies as a change of measure only if this many standard SKUs step
// by the same exact factor on it...
export const MIN_EVENT_MODELS = 5;
// ...and, at each provider counted, those steps are at least this share of
// that provider's own price moves that day.
export const MIN_EVENT_EXACT_SHARE = 0.8;

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

/**
 * Alternate-billing SKUs (':batch', ':free', ':thinking', ...) are the same
 * model sold on different terms. They never count toward detecting a change,
 * and callers keep them out of any average that describes the standard SKU.
 */
export function isAltBillingSku(model) {
  return typeof model === 'string' && model.includes(':');
}

/** The row's calendar day, 'YYYY-MM-DD', or null. */
export function rowDay(row) {
  const d = row?.date;
  return typeof d === 'string' && d.length >= 10 ? d.slice(0, 10) : null;
}

/**
 * The one place a model price is read from a row, in $/token.
 *
 * Returns null for anything that is not a usable price. $0.00 is refused by
 * default because on a paid model class it is a free / experimental SKU filed
 * under the same family (Google's gemini-2.5-pro-exp-* rows), and averaging it
 * in reads as a price cut that never happened. Pass { allowZero: true } where
 * each model is its own row and a genuinely free model should show as free.
 */
export function readPrice(row, metric, { allowZero = false } = {}) {
  const field = METRIC_FIELD[metric];
  if (!field) throw new Error('readPrice: metric must be "input" or "output"');
  const v = row?.[field];
  if (!isNum(v) || v < 0) return null;
  if (v === 0 && !allowZero) return null;
  return v;
}

/**
 * -1 when `next` is exactly half of `prev`, +1 when exactly double, else 0.
 */
export function exactStepDirection(prev, next) {
  if (!(prev > 0) || !(next > 0)) return 0;
  const r = next / prev;
  if (Math.abs(r - 0.5) <= 0.5 * EXACT_RATIO_TOLERANCE) return -1;
  if (Math.abs(r - 2) <= 2 * EXACT_RATIO_TOLERANCE) return 1;
  return 0;
}

function samePrice(a, b) {
  return a > 0 && b > 0 && Math.abs(a - b) <= EXACT_RATIO_TOLERANCE * Math.max(a, b);
}

/**
 * Every price move in one model's daily history, oldest first.
 * `days` is a Map of 'YYYY-MM-DD' -> price ($/token, > 0).
 * A step's `date` is the first day on the new price; `prevDate` the last day
 * on the old one — a capture gap sits between them.
 */
export function priceSteps(days) {
  const dates = Array.from(days.keys()).sort();
  const steps = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = days.get(dates[i - 1]);
    const next = days.get(dates[i]);
    if (prev === next) continue;
    steps.push({ prevDate: dates[i - 1], date: dates[i], prev, next, direction: exactStepDirection(prev, next) });
  }
  return steps;
}

/** slug -> model -> (day -> price), from priced rows, every SKU included. */
function collectDailySeries(providerResults, metric) {
  const out = new Map();
  for (const pr of providerResults || []) {
    if (!pr || !pr.slug) continue;
    const byModel = new Map();
    for (const row of pr.rows || []) {
      if (typeof row?.model !== 'string') continue;
      const day = rowDay(row);
      if (!day) continue;
      const v = readPrice(row, metric);
      if (v === null) continue;
      let days = byModel.get(row.model);
      if (!days) byModel.set(row.model, (days = new Map()));
      days.set(day, v);
    }
    out.set(pr.slug, byModel);
  }
  return out;
}

/* ── Detection ─────────────────────────────────────────────────────────── */

function detectFromSeries(seriesBySlug) {
  // date -> provider -> { halved: [...], doubled: [...], other: n }
  //
  // The exact-step share is judged PER PROVIDER, never across the whole
  // request. A change of measure is something the source does to the
  // providers it touches; an unrelated provider repricing on the same day
  // says nothing about it. Judged across the request, the verdict would
  // depend on which providers happened to be fetched — the pricing matrix
  // (eight providers) and the peer matrix (three) could disagree about the
  // same day, and a few ordinary moves elsewhere would let the phantom cut
  // back into the eight-provider matrix.
  const byDate = new Map();
  for (const [slug, byModel] of seriesBySlug) {
    for (const [model, days] of byModel) {
      if (isAltBillingSku(model)) continue;
      for (const s of priceSteps(days)) {
        let d = byDate.get(s.date);
        if (!d) byDate.set(s.date, (d = new Map()));
        let p = d.get(slug);
        if (!p) d.set(slug, (p = { halved: [], doubled: [], other: 0 }));
        if (s.direction < 0) p.halved.push({ provider: slug, model });
        else if (s.direction > 0) p.doubled.push({ provider: slug, model });
        else p.other += 1;
      }
    }
  }

  const events = [];
  for (const date of Array.from(byDate.keys()).sort()) {
    const perProvider = byDate.get(date);
    for (const direction of ['halved', 'doubled']) {
      // A provider takes part only when this exact step is most of ITS OWN
      // price moves that day.
      const list = [];
      let total = 0;
      for (const p of perProvider.values()) {
        const mine = p[direction];
        const moves = p.halved.length + p.doubled.length + p.other;
        if (!mine.length || mine.length / moves < MIN_EVENT_EXACT_SHARE) continue;
        list.push(...mine);
        total += moves;
      }
      if (list.length < MIN_EVENT_MODELS) continue;
      const counts = new Map();
      for (const m of list) counts.set(m.provider, (counts.get(m.provider) || 0) + 1);
      events.push({
        effectiveDate: date,
        direction,
        factor: direction === 'halved' ? 0.5 : 2,
        modelCount: list.length,
        providers: Array.from(counts.keys()).sort(),
        byProvider: Array.from(counts, ([provider, count]) => ({ provider, count }))
          .sort((a, b) => b.count - a.count || (a.provider < b.provider ? -1 : 1)),
        models: list.slice().sort((a, b) =>
          a.provider === b.provider ? (a.model < b.model ? -1 : 1) : (a.provider < b.provider ? -1 : 1)),
        movesThatDay: total,
        exactShare: round3(list.length / total),
      });
    }
  }
  return events;
}

/**
 * Every date on which the source changed what it reports for this metric,
 * found from the rows alone. `providerResults` is [{ slug, rows }].
 */
export function detectMeasureBreaks(providerResults, metric) {
  return detectFromSeries(collectDailySeries(providerResults, metric));
}

/* ── Per-model classification ──────────────────────────────────────────── */

/**
 * Which measure one model's price is on, day by day.
 *
 * `slug` is the model's provider. A model first priced on or after a change
 * that touched its provider starts on that change's measure (see header).
 *
 * Returns { touched, segments: [{ from, basis }], changes: [...] }. `from` is
 * the first day on that basis (null for the first segment). `touched` is false
 * for a model no change applied to; such a model is on the same measure for
 * its whole history and is compatible with every period.
 */
export function modelBasisTimeline(days, events, slug) {
  const evs = (events || []).slice().sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
  const segments = [{ from: null, basis: BASIS_ORIGIN }];
  const changes = [];
  if (!evs.length || !days || !days.size) return { touched: false, segments, changes };

  // Listed on or after a change at a provider that change touched: on its
  // measure from day one. It cannot "return" below that — there is no earlier
  // figure to return to.
  const firstDay = Array.from(days.keys()).sort()[0];
  const listedAfter = slug == null ? [] :
    evs.filter(e => e.effectiveDate <= firstDay && (e.providers || []).includes(slug));
  if (listedAfter.length) {
    const ev = listedAfter[listedAfter.length - 1];
    segments[0] = { from: null, basis: ev.effectiveDate };
    changes.push({ kind: 'listed-after', date: firstDay, basis: ev.effectiveDate });
  }

  const stack = [];                       // measures this model has been moved onto
  for (const s of priceSteps(days)) {
    const top = stack[stack.length - 1];
    // Back onto exactly the figure it carried before the change, by the exact
    // inverse factor: the model has returned to the earlier measure.
    if (top && s.direction === -top.direction && samePrice(s.next, top.prePrice)) {
      stack.pop();
      const basis = stack.length ? stack[stack.length - 1].basis : segments[0].basis;
      segments.push({ from: s.date, basis });
      changes.push({ kind: 'returned', date: s.date, basis });
      continue;
    }
    if (s.direction === 0) continue;
    // The model's own exact step, in the change's direction, across the
    // change's date. A capture gap is allowed to sit across the date.
    const ev = evs.find(e =>
      s.prevDate < e.effectiveDate && e.effectiveDate <= s.date &&
      (e.direction === 'halved' ? -1 : 1) === s.direction);
    if (!ev) continue;
    stack.push({ basis: ev.effectiveDate, prePrice: s.prev, direction: s.direction });
    segments.push({ from: s.date, basis: ev.effectiveDate });
    changes.push({ kind: 'moved', date: s.date, basis: ev.effectiveDate });
  }
  return { touched: changes.length > 0, segments, changes };
}

function basisAt(segments, day) {
  let basis = BASIS_ORIGIN;
  for (const seg of segments) {
    if (seg.from === null || seg.from <= day) basis = seg.basis;
    else break;
  }
  return basis;
}

/**
 * Everything a caller needs for one metric, built once per request from that
 * request's rows.
 *
 *   events              detectMeasureBreaks() for these rows
 *   basisOf(slug, model, day)
 *                       the measure that model's price is on that day, or
 *                       null for a model no change touched (it counts on
 *                       whichever measure a period is on)
 *   touchedModels(slug) the models a change applied to, with their timeline
 */
export function buildBasisBook(providerResults, metric) {
  const seriesBySlug = collectDailySeries(providerResults, metric);
  const events = detectFromSeries(seriesBySlug);
  const timelines = new Map();              // slug -> model -> timeline (touched only)
  if (events.length) {
    for (const [slug, byModel] of seriesBySlug) {
      const touched = new Map();
      for (const [model, days] of byModel) {
        const t = modelBasisTimeline(days, events, slug);
        if (t.touched) touched.set(model, t);
      }
      timelines.set(slug, touched);
    }
  }
  return {
    metric,
    events,
    basisOf(slug, model, day) {
      const t = timelines.get(slug)?.get(model);
      if (!t || !day) return null;
      return basisAt(t.segments, day);
    },
    /**
     * What one observation's price must be multiplied by to put it on the
     * earlier (origin) measure: 1 for an untouched model or a day before its
     * change; the inverse of the change's exact factor for a model the change
     * MOVED (x2 for a halving); null for a model first listed after the
     * change, which the source never reported the earlier way. One change
     * deep — no model in the history has moved twice.
     */
    linkOf(slug, model, day) {
      const t = timelines.get(slug)?.get(model);
      if (!t || !day) return 1;
      const b = basisAt(t.segments, day);
      if (b === BASIS_ORIGIN) return 1;
      if (!t.changes.some(c => c.kind === 'moved' && c.basis === b)) return null;
      const ev = events.find(e => e.effectiveDate === b);
      return ev && ev.factor > 0 ? 1 / ev.factor : null;
    },
    touchedModels(slug) {
      return Array.from(timelines.get(slug) || [], ([model, t]) => ({ model, changes: t.changes }));
    },
  };
}

/* ── Period levels on one measure ──────────────────────────────────────── */

function slot() {
  // linkedSum: the same observations on the origin measure (see linkOf);
  // unlinked: how many had no link, which makes the period's linked level null.
  return { sum: 0, n: 0, models: new Set(), linkedSum: 0, unlinked: 0 };
}

/** An empty accumulator for one period's observations. */
export function createTally() {
  return { neutral: slot(), byBasis: new Map() };
}

/** Get-or-create the tally for `key` in a Map. */
export function tallyFor(map, key) {
  let t = map.get(key);
  if (!t) map.set(key, (t = createTally()));
  return t;
}

/**
 * Add one observation. `basis` is what basisOf() returned for it: null for an
 * untouched model, otherwise the measure that model was on that day.
 */
export function addToTally(tally, basis, value, model, link) {
  let s;
  // No link given: an observation on the origin measure (or untouched) needs
  // none; one on a changed measure is left unlinked, so growth across the
  // change is refused rather than taken at face value.
  if (link === undefined) link = basis == null || basis === BASIS_ORIGIN ? 1 : null;
  if (basis == null) { s = tally.neutral; link = 1; }
  else {
    s = tally.byBasis.get(basis);
    if (!s) tally.byBasis.set(basis, (s = slot()));
  }
  s.sum += value;
  s.n += 1;
  if (link == null) s.unlinked += 1;
  else s.linkedSum += value * link;
  if (model != null) s.models.add(model);
}

/** One tally holding every observation of several (e.g. a model's variants). */
export function mergeTallies(tallies) {
  const out = createTally();
  const into = (dst, src) => {
    dst.sum += src.sum;
    dst.n += src.n;
    dst.linkedSum += src.linkedSum || 0;
    dst.unlinked += src.unlinked || 0;
    for (const m of src.models) dst.models.add(m);
  };
  for (const t of tallies || []) {
    if (!t) continue;
    into(out.neutral, t.neutral);
    for (const [b, s] of t.byBasis) {
      let d = out.byBasis.get(b);
      if (!d) out.byBasis.set(b, (d = slot()));
      into(d, s);
    }
  }
  return out;
}

/** Older measure first; BASIS_ORIGIN before any dated change. */
export function compareBasis(a, b) {
  if (a === b) return 0;
  if (a === BASIS_ORIGIN) return -1;
  if (b === BASIS_ORIGIN) return 1;
  return a < b ? -1 : 1;
}

/**
 * A period's level, on ONE measure.
 *
 * The measure holding most of the touched models' observations wins; a tie
 * goes to the newer measure. Observations on any other measure are left out
 * and reported in `excludedN`. Untouched models always count. A period with
 * no touched model at all is on BASIS_ORIGIN: its models read the same way
 * they always have.
 *
 * Returns { mean, n, basis, models, excludedN, excludedModels }. `mean` is in
 * the units the observations were added in ($/token), or null when empty.
 */
export function resolveTally(tally) {
  let basis = BASIS_ORIGIN;
  let chosen = null;
  for (const [b, s] of tally.byBasis) {
    if (!chosen || s.n > chosen.n || (s.n === chosen.n && compareBasis(b, basis) > 0)) {
      basis = b;
      chosen = s;
    }
  }
  const n = tally.neutral.n + (chosen ? chosen.n : 0);
  const sum = tally.neutral.sum + (chosen ? chosen.sum : 0);
  const models = new Set(tally.neutral.models);
  if (chosen) for (const m of chosen.models) models.add(m);
  let excludedN = 0;
  const excludedModels = new Set();
  for (const [b, s] of tally.byBasis) {
    if (b === basis) continue;
    excludedN += s.n;
    for (const m of s.models) excludedModels.add(m);
  }
  // The same observations on the origin measure, or null if any of them
  // cannot be linked there (a model listed after the change).
  const unlinked = tally.neutral.unlinked + (chosen ? chosen.unlinked : 0);
  const linkedMean = n && !unlinked
    ? (tally.neutral.linkedSum + (chosen ? chosen.linkedSum : 0)) / n
    : null;
  return { mean: n ? sum / n : null, n, basis, models, excludedN, excludedModels, linkedMean };
}

/**
 * Resolve a whole series of period tallies into the shapes the endpoints
 * publish. `tallies` is a Map (or object) of periodId -> tally.
 *
 *   values    { [pid]: number|null }       mean x scale, to 3 dp
 *   levels    { [pid]: { value, basis } }  what growthSeries() compares
 *   basis     { [pid]: basis }             ONLY periods not on BASIS_ORIGIN
 *   excluded  { [pid]: n }                 ONLY periods that left observations out
 *   n         { [pid]: n }                 observations each value rests on
 *
 * `basis` and `excluded` are sparse on purpose: almost every period is on the
 * original measure, and the payload should not grow by a map of "origin".
 * Wrap per-field groups of them in sparse() before publishing.
 */
export function resolvePeriodTallies(tallies, scale = 1_000_000) {
  const values = {}, levels = {}, basis = {}, excluded = {}, n = {};
  const entries = tallies instanceof Map ? tallies.entries() : Object.entries(tallies || {});
  for (const [pid, t] of entries) {
    const r = resolveTally(t);
    const v = r.mean === null ? null : round3(r.mean * scale);
    values[pid] = v;
    // `linked` is unrounded: growth across a change divides two of them.
    levels[pid] = { value: v, basis: r.basis, linked: r.linkedMean === null ? null : r.linkedMean * scale };
    if (r.basis !== BASIS_ORIGIN) basis[pid] = r.basis;
    if (r.excludedN > 0) excluded[pid] = r.excludedN;
    n[pid] = r.n;
  }
  return { values, levels, basis, excluded, n };
}

/**
 * Whether one day's observation counts toward a period on `periodBasis`:
 * always for an untouched model, otherwise only on the same measure.
 */
export function countsToward(dayBasis, periodBasis) {
  return dayBasis == null || dayBasis === (periodBasis || BASIS_ORIGIN);
}

/* ── Growth ────────────────────────────────────────────────────────────── */

function hasLevel(x) {
  return !!x && isNum(x.value);
}

/** True when both periods carry a level but stand on different measures. */
export function isMeasureChange(cur, prior) {
  if (!hasLevel(cur) || !hasLevel(prior)) return false;
  return (cur.basis || BASIS_ORIGIN) !== (prior.basis || BASIS_ORIGIN);
}

/**
 * Growth between two periods as a ratio (-0.123 = -12.3%), or null when the
 * comparison is not one: either side missing, a zero prior, or — the point of
 * this module — the two periods standing on different measures.
 */
export function basisGrowth(cur, prior) {
  if (!hasLevel(cur) || !hasLevel(prior) || !(prior.value > 0)) return null;
  if (isMeasureChange(cur, prior)) return null;
  return round3((cur.value - prior.value) / prior.value);
}

/**
 * Growth between two periods on DIFFERENT measures, taken between their
 * origin-measure levels (resolveTally's linkedMean). Null unless both periods
 * could be linked there.
 */
export function linkedGrowth(cur, prior) {
  if (!isMeasureChange(cur, prior)) return null;
  const a = cur?.linked, b = prior?.linked;
  if (!isNum(a) || !isNum(b) || !(b > 0)) return null;
  // + 0: an unchanged price across the change must print 0.0%, never -0.0%.
  return round3((a - b) / b) + 0;
}

/** What a linked change rests on, in words, for its tooltip. */
export function linkedChangeNote(cur, prior, priorLabel, events) {
  const a = cur?.basis || BASIS_ORIGIN;
  const b = prior?.basis || BASIS_ORIGIN;
  const dated = [a, b].filter(x => x !== BASIS_ORIGIN).sort();
  const date = dated[dated.length - 1] || null;
  const ev = (events || []).find(e => e.effectiveDate === date) || null;
  const [what, how] = !ev
    ? ['changed the figure it reports', 'at the reported price times the exact factor of that change']
    : ev.direction === 'halved'
      ? ['cut the figure it reports to exactly half', 'at twice the reported price']
      : ['doubled the figure it reports', 'at half the reported price'];
  return (
    'Measured across the source\'s change of reporting' + (date ? ' on ' + date : '') +
    ', which ' + what + ': compared ' + how + ' — the exact factor of that change — so this and ' +
    (priorLabel || 'the prior period') + ' stand on one basis.'
  );
}

/** 'YYYY-Qn' -> 'Qn YYYY'; 'YYYY-MM' -> 'Mon YYYY'. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function periodLabel(pid) {
  if (typeof pid !== 'string') return 'the prior period';
  let m = pid.match(/^(\d{4})-Q([1-4])$/);
  if (m) return 'Q' + m[2] + ' ' + m[1];
  m = pid.match(/^(\d{4})-(\d{2})$/);
  if (m) return MONTHS[+m[2] - 1] + ' ' + m[1];
  return pid;
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/** Why a growth cell is empty, in words, for its tooltip. */
export function measureChangeReason(cur, prior, priorLabel, events) {
  const a = cur?.basis || BASIS_ORIGIN;
  const b = prior?.basis || BASIS_ORIGIN;
  const dated = [a, b].filter(x => x !== BASIS_ORIGIN).sort();
  const date = dated[dated.length - 1] || null;
  const ev = (events || []).find(e => e.effectiveDate === date) || null;
  const what = ev
    ? ' (that day its figure for ' + ev.modelCount + ' models ' +
      (ev.direction === 'halved' ? 'halved' : 'doubled') + ' at once)'
    : '';
  return (
    'Not comparable: the source changed how it reports prices' + (date ? ' on ' + date : '') + what +
    ', and ' + (priorLabel || 'the prior period') + ' is on the other side of that change.' +
    ' The gap is a change of measure, not a price move.'
  );
}

/**
 * { field: { pid: x } } with the empty fields dropped, or undefined when
 * nothing is left — so a series the change never touched carries no
 * annotation at all, and JSON leaves the key out.
 */
export function sparse(byField) {
  const out = {};
  for (const [k, v] of Object.entries(byField || {})) {
    if (v && Object.keys(v).length) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Period-over-period growth for one series, with the refusal applied.
 *
 *   levels   { [pid]: { value, basis } }   (resolvePeriodTallies().levels)
 *   priorOf  pid -> the period to compare against
 *   skip     a period left out entirely (the one still in progress)
 *
 * Returns { growth: { [pid]: ratio }, measureChanged: { [pid]: reason } }.
 * A period in neither map had nothing to compare against.
 */
export function growthSeries(levels, priorOf, { skip = null, events = [] } = {}) {
  const growth = {};
  const measureChanged = {};
  const linked = {};
  for (const pid of Object.keys(levels || {})) {
    if (pid === skip) continue;
    const ppid = priorOf(pid);
    const cur = levels[pid];
    const prior = ppid ? levels[ppid] : null;
    const g = basisGrowth(cur, prior);
    if (g !== null) growth[pid] = g;
    else if (isMeasureChange(cur, prior)) {
      const lg = linkedGrowth(cur, prior);
      if (lg !== null) {
        growth[pid] = lg;
        linked[pid] = linkedChangeNote(cur, prior, periodLabel(ppid), events);
      } else {
        measureChanged[pid] = measureChangeReason(cur, prior, periodLabel(ppid), events) +
          ' It cannot be linked across that change either: a model here was first listed after it, ' +
          'so the source never reported it the earlier way.';
      }
    }
  }
  return { growth, measureChanged, linked };
}

/* ── The explanation a reader sees ─────────────────────────────────────── */

/**
 * Plain-words description of every detected change, for the caption above a
 * table, or null when there is none. Takes one or more event lists (input and
 * output are detected separately) and describes each date once.
 * `labelOf` turns a provider slug into its display name.
 *
 * Returns { headline, detail }.
 */
export function describeMeasureBreaks(eventLists, labelOf = s => s) {
  const byKey = new Map();
  for (const list of eventLists || []) {
    for (const ev of list || []) {
      const k = ev.effectiveDate + '|' + ev.direction;
      const had = byKey.get(k);
      if (!had || ev.modelCount > had.modelCount) byKey.set(k, ev);
    }
  }
  const evs = Array.from(byKey.values()).sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1));
  if (!evs.length) return null;

  const sentences = evs.map(ev => {
    const who = listJoin(ev.byProvider.map(p => p.count + ' ' + labelOf(p.provider)));
    const across = ev.providers.length > 1
      ? ' Unrelated vendors do not reprice by one identical factor on the same day, so this is a change in what the source reports, not a price move.'
      : ' A step this uniform is treated as a change in what the source reports, not a price move.';
    return (
      'On ' + ev.effectiveDate + ' its figure for ' + who + ' models ' +
      (ev.direction === 'halved' ? 'fell to exactly half' : 'rose to exactly double') +
      ' of the day before, every one by the same factor.' + across
    );
  });

  const dates = listJoin(evs.map(e => e.effectiveDate));
  return {
    headline: 'The source changed how it reports prices on ' + dates + '.',
    detail:
      sentences.join(' ') +
      ' Prices from then on are shown exactly as the source now reports them. Growth across the change ' +
      'compares like with like: each model the change moved is compared at ' +
      (evs.every(e => e.direction === 'halved') ? 'twice' : evs.every(e => e.direction === 'doubled') ? 'half' : 'the inverse of') +
      ' its reported price, the exact factor the change applied. Only a figure resting on a model first listed after the change cannot be linked, and reads measure changed.',
  };
}
