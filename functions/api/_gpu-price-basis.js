/**
 * GPU price basis — normalization, period headline, and change detection.
 *
 * WHY THIS EXISTS
 * ───────────────
 * getdeploying.com has published this listing three different ways, and each
 * change moved the price into a different field with a different MEANING:
 *
 *   era 1  2026-04-21 → 2026-07-27   legacy table row, `data-minprice` plus a
 *                                    "$min - $max" cell.
 *                                    → minPricePerHour + maxPricePerHour set.
 *                                    The headline was the FLOOR: the single
 *                                    cheapest listing of ~48 vendors. H100
 *                                    read $0.40 under a $14.90 ceiling.
 *
 *   era 2  2026-07-28 → 2026-08-21   card layout, one price in `data-price`,
 *                                    no range. The parser of the day still
 *                                    looked for `data-minprice`, found none,
 *                                    and the lone dollar figure fell through
 *                                    to maxPricePerHour.
 *                                    → maxPricePerHour ONLY. min, median,
 *                                    midpoint and spread all null.
 *
 *   era 3  2026-09-11 → present      same card layout, parser repaired.
 *                                    → medianPricePerHour set.
 *
 * Era 2 and era 3 are THE SAME MEASURE — the vendor median — sitting in two
 * different fields. Nothing downstream knew that, so era 2 rendered as "no
 * price" and August went blank on the customer's matrix while September
 * appeared to leap from $0.40 to $3.34. That leap is a unit change, not a
 * market move: on the median basis H100 has held ~$3.3–3.4/hr continuously
 * since 2026-07-28.
 *
 * The remap is a read-time reclassification. Stored snapshots are left
 * exactly as captured — the raw record is the evidence, and rewriting KV to
 * paper over a parser bug is how you lose the ability to audit it later.
 *
 * WHAT MAKES THE REMAP SAFE
 * ─────────────────────────
 * Era 1 and era 2 records are disjoint in shape, with no overlap anywhere in
 * the captured history:
 *   era 1 — min AND max set, midpoint AND spread set  (546 records)
 *   era 2 — max only; min, median, midpoint, spread ALL null  (150 records)
 * A range always yields a midpoint and a spread, so "max with no min, no
 * midpoint and no spread" cannot be a range that lost a field — it can only
 * be a single published figure. The remap therefore requires the full
 * signature, not just the absence of a min.
 */

// A daily point's measure, after normalization. 'floor' is the cheapest
// listing; 'median' is the vendor median. They are not interchangeable and
// must never be compared to one another.
export const BASIS_FLOOR = 'floor';
export const BASIS_MEDIAN = 'median';

export const BASIS_LABEL = {
  [BASIS_MEDIAN]: 'median $/hr across providers',
  [BASIS_FLOOR]: 'floor of the vendor range (min $/hr)',
};

export const BASIS_SHORT = {
  [BASIS_MEDIAN]: 'median',
  [BASIS_FLOOR]: 'floor',
};

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * True when a daily point carries the era-2 signature: a lone price that the
 * parser of the day dropped into maxPricePerHour because it was hunting for
 * a range that the upstream had stopped publishing.
 *
 * Every condition is load-bearing. Dropping the midpoint/spread checks would
 * let a genuine range whose min failed to parse be relabelled as a median,
 * which would splice a $14.90 ceiling into the median series.
 */
export function isSingleValueInMaxField(p) {
  if (!p) return false;
  return (
    !isNum(p.minPricePerHour) &&
    !isNum(p.medianPricePerHour) &&
    isNum(p.maxPricePerHour) &&
    !isNum(p.priceMidpoint) &&
    !isNum(p.spreadMultiple) &&
    !isNum(p.spreadAbsolute)
  );
}

/**
 * Reclassify one daily point. Returns a new object; the input is untouched.
 * Adds:
 *   dailyBasis     'floor' | 'median' | null — what this day's price measures
 *   dailyPrice     the headline number for that basis, or null
 *   basisRemapped  true when the era-2 rescue fired, so the UI, the export
 *                  and any operator reading the JSON can see that this value
 *                  was recovered rather than captured into its final field
 */
export function normalizeDailyPoint(p) {
  if (!p) return p;
  if (isSingleValueInMaxField(p)) {
    const v = p.maxPricePerHour;
    return {
      ...p,
      // The value moves into the field that matches its meaning. maxPrice is
      // cleared because there was never a ceiling to report — leaving it set
      // would make the tooltip claim a $3.39 median sits under a $3.39
      // ceiling, which reads as a zero-width market.
      maxPricePerHour: null,
      medianPricePerHour: v,
      dailyBasis: BASIS_MEDIAN,
      dailyPrice: v,
      basisRemapped: true,
    };
  }
  if (isNum(p.medianPricePerHour)) {
    return { ...p, dailyBasis: BASIS_MEDIAN, dailyPrice: p.medianPricePerHour, basisRemapped: false };
  }
  if (isNum(p.minPricePerHour)) {
    return { ...p, dailyBasis: BASIS_FLOOR, dailyPrice: p.minPricePerHour, basisRemapped: false };
  }
  return { ...p, dailyBasis: null, dailyPrice: null, basisRemapped: false };
}

export function normalizeDailySeries(points) {
  return (points || []).map(normalizeDailyPoint);
}

function mean(nums) {
  const valid = nums.filter(isNum);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function round4(v) {
  return isNum(v) ? +v.toFixed(4) : null;
}

/**
 * The headline price for a calendar period, computed from ONE basis.
 *
 * A period that straddles the 2026-07-28 boundary holds days of both kinds.
 * Averaging them together would invent a number that measures nothing; and
 * the previous rule ("use the median if any median exists") was just as bad
 * in the other direction — it would have turned July, 27 of whose 31 days
 * are floor observations, into a 4-day median and labelled it a month.
 *
 * So: the basis with the most priced days wins, the minority days are
 * excluded from the average, and the period reports the split. Ties go to
 * the median, which is the measure the feed publishes going forward.
 *
 * Returns the alternate basis's average too. That is what actually answers
 * "why did September jump?" — July's own median-basis days sat at ~$3.06,
 * so on a like-for-like measure nothing jumped at all.
 */
export function periodHeadline(points) {
  const pts = (points || []).map(p => (p.dailyBasis === undefined ? normalizeDailyPoint(p) : p));

  const byBasis = {
    [BASIS_MEDIAN]: { dates: new Set(), values: [] },
    [BASIS_FLOOR]: { dates: new Set(), values: [] },
  };
  for (const p of pts) {
    if (!p.dailyBasis || !isNum(p.dailyPrice)) continue;
    const b = byBasis[p.dailyBasis];
    if (!b) continue;
    b.dates.add(p.date);
    b.values.push(p.dailyPrice);
  }

  const medDays = byBasis[BASIS_MEDIAN].dates.size;
  const floorDays = byBasis[BASIS_FLOOR].dates.size;

  const basisDayCounts = { median: medDays, floor: floorDays };

  if (!medDays && !floorDays) {
    return {
      headlinePricePerHour: null,
      priceBasis: null,
      basisDayCounts,
      mixedBasis: false,
      alternateBasis: null,
      alternatePricePerHour: null,
      basisDaysUsed: 0,
    };
  }

  const primary = medDays >= floorDays ? BASIS_MEDIAN : BASIS_FLOOR;
  const alternate = primary === BASIS_MEDIAN ? BASIS_FLOOR : BASIS_MEDIAN;
  const altDays = byBasis[alternate].dates.size;

  return {
    headlinePricePerHour: round4(mean(byBasis[primary].values)),
    priceBasis: primary,
    basisDayCounts,
    // A straddle period. Growth into and out of it is still refused across
    // the change, but the period itself needs to say that its own average
    // ignores some of its captured days.
    mixedBasis: medDays > 0 && floorDays > 0,
    alternateBasis: altDays > 0 ? alternate : null,
    alternatePricePerHour: altDays > 0 ? round4(mean(byBasis[alternate].values)) : null,
    basisDaysUsed: byBasis[primary].dates.size,
  };
}

/** Days in the period that carry a price on the period's own basis. */
export function pricedDatesForBasis(points, basis) {
  const out = new Set();
  for (const p of points || []) {
    const n = p.dailyBasis === undefined ? normalizeDailyPoint(p) : p;
    if (n.dailyBasis === basis && isNum(n.dailyPrice)) out.add(n.date);
  }
  return out;
}

export function pctChange(curr, prior) {
  if (!isNum(curr) || !isNum(prior) || prior === 0) return null;
  return +(((curr - prior) / prior) * 100).toFixed(2);
}

/**
 * Growth between two periods, or null when the comparison is not one.
 *
 * Refused when either side has no price, and — the point of this whole
 * module — when the two sides were measured differently. Reporting
 * $0.40 (floor) against $3.34 (median) as +731% would be a fabricated
 * market event, and it is precisely the number a customer would escalate.
 */
export function periodGrowth(cur, prior) {
  if (!cur || !prior) return null;
  if (!cur.priceBasis || !prior.priceBasis) return null;
  if (cur.priceBasis !== prior.priceBasis) return null;
  return pctChange(cur.headlinePricePerHour, prior.headlinePricePerHour);
}

/** Why a growth cell is empty, in words, for the tooltip. */
export function growthRefusalReason(cur, prior, priorLabel) {
  if (!cur || !cur.priceBasis) return 'No price captured for this period.';
  if (!prior || !prior.priceBasis) {
    return 'No price captured for ' + (priorLabel || 'the prior period') + ', so there is nothing to compare against.';
  }
  if (cur.priceBasis !== prior.priceBasis) {
    return (
      'Not comparable: ' + (priorLabel || 'the prior period') + ' is measured as the ' +
      BASIS_LABEL[prior.priceBasis] + ', this period as the ' + BASIS_LABEL[cur.priceBasis] +
      '. The source changed what it publishes; the difference between the two numbers is a change of measure, not a price move.'
    );
  }
  return null;
}

/**
 * Walk the whole captured history and describe every point where the measure
 * changed. The matrix uses this to draw the boundary in the right place
 * instead of hard-coding 2026-07-28, so the next time the upstream changes
 * shape the dashboard explains itself without a code change.
 *
 * `seriesBySku` is { sku: [normalized daily points, oldest first] }.
 */
export function detectBasisTimeline(seriesBySku) {
  // Collapse to one basis per date. A date is 'mixed' only if different SKUs
  // disagree on the same day, which would itself be a capture fault worth
  // seeing.
  const byDate = new Map();
  for (const pts of Object.values(seriesBySku || {})) {
    for (const p of pts || []) {
      if (!p.dailyBasis) continue;
      const cur = byDate.get(p.date);
      if (!cur) byDate.set(p.date, p.dailyBasis);
      else if (cur !== p.dailyBasis) byDate.set(p.date, 'mixed');
    }
  }
  const dates = Array.from(byDate.keys()).sort();

  const segments = [];
  for (const d of dates) {
    const b = byDate.get(d);
    const last = segments[segments.length - 1];
    if (last && last.basis === b) {
      last.to = d;
      last.days++;
    } else {
      segments.push({ basis: b, from: d, to: d, days: 1 });
    }
  }

  const changes = [];
  for (let i = 1; i < segments.length; i++) {
    changes.push({
      from: segments[i - 1].basis,
      to: segments[i].basis,
      // The first day measured the new way, and the last day measured the
      // old way — both, because the boundary sits between them and a reader
      // needs to know which side a given date falls on.
      effectiveDate: segments[i].from,
      previousDate: segments[i - 1].to,
      fromPeriodMonth: segments[i - 1].to.slice(0, 7),
      toPeriodMonth: segments[i].from.slice(0, 7),
    });
  }

  return { segments, changes, currentBasis: segments.length ? segments[segments.length - 1].basis : null };
}

/**
 * Period-level view of the same thing: which calendar periods sit either
 * side of a change, and which one straddles it. The UI draws its divider
 * from `boundaryBefore`/`boundaryAfter`.
 */
export function basisChangeForPeriods(periodRecordsBySku, periodIds) {
  const basisByPeriod = {};
  const mixedPeriods = new Set();
  for (const recs of Object.values(periodRecordsBySku || {})) {
    for (const r of recs || []) {
      if (!r.priceBasis) continue;
      if (r.mixedBasis) mixedPeriods.add(r.period);
      const cur = basisByPeriod[r.period];
      if (!cur) basisByPeriod[r.period] = r.priceBasis;
      else if (cur !== r.priceBasis) basisByPeriod[r.period] = 'mixed';
    }
  }
  const ordered = (periodIds || []).filter(p => basisByPeriod[p]);
  const boundaries = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = basisByPeriod[ordered[i - 1]];
    const cur = basisByPeriod[ordered[i]];
    if (prev !== cur) {
      boundaries.push({ boundaryBefore: ordered[i - 1], boundaryAfter: ordered[i], from: prev, to: cur });
    }
  }
  return { basisByPeriod, mixedPeriods: Array.from(mixedPeriods).sort(), boundaries };
}
