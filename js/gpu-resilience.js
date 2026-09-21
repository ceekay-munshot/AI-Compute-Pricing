/**
 * The GPU price resilience signal: one rule, read by both places that show it.
 *
 * GPU → Financial Correlation renders it (js/dashboard.jsx) and the Excel
 * export writes it (js/gpu-xlsx-report.js). Each used to carry its own copy,
 * and the copies drifted: the table moved to three states while the workbook
 * kept the old binary, so every period whose two readings disagreed read
 * "Mixed" on screen and "Falling" in the download. Both now call
 * resilienceSignal() and differ only in how they draw its answer.
 *
 * For period P it reads the growth at P (P against P-1) and the growth at P-1
 * (P-1 against P-2):
 *   both >= 0   "Stable/up 2M" or "Stable/up 2Q"   held or rose twice
 *   both <  0   "Falling 2M" or "Falling 2Q"       fell twice
 *   otherwise   "Mixed"                            the readings disagree
 * Only both-down is falling. The old binary called B200 "Falling" at +2.0%
 * because the month before it was -0.9%.
 *
 * A period is left ungraded, and the state says why, when (checked in order):
 *   no-capture       nothing was captured for it
 *   no-price         it was captured but carries no price
 *   in-progress      it is still running, so its average is not comparable
 *   measure-changed  P, P-1 and P-2 were not all measured the same way, so a
 *                    "trend" would be the source changing units
 *   no-lookback      either growth reading is unavailable
 *
 * The caller resolves P-1 and P-2 by calendar id, never by column position:
 * the axis is continuous, so a stalled feed leaves an empty column, and
 * stepping back one slot would compare across the hole.
 */

// Below this share of priced days a period average is still shown, but a
// reading that rests on it is marked as indicative only.
export const LOW_PRICED_COVERAGE = 0.75;

// The look-back is two periods of whatever the axis is.
export function resilienceSpan(quarterly) {
  return quarterly ? "2Q" : "2M";
}

/**
 * @param {object}  a
 * @param {boolean} a.captured       a capture exists for P
 * @param {boolean} a.priced         P carries a price
 * @param {boolean} a.inProgress     P is still running
 * @param {Array}   a.bases          the measure of [P, P-1, P-2]; null where none
 * @param {number}  a.growth         growth at P, in percent
 * @param {number}  a.priorGrowth    growth at P-1, in percent
 * @param {number}  a.coverage       share of P's days carrying a price, 0..1
 * @param {number}  a.priorCoverage  the same for P-1
 * @param {boolean} a.quarterly      true on the quarter axis, false on months
 * @returns {{state:string, label?:string, thin?:boolean, bases?:string[]}}
 */
export function resilienceSignal(a) {
  if (!a.captured) return { state: "no-capture" };
  if (!a.priced) return { state: "no-price" };
  if (a.inProgress) return { state: "in-progress" };

  const bases = a.bases || [];
  if (bases[0] && bases.some(b => b && b !== bases[0])) {
    return { state: "measure-changed", bases: bases.filter(Boolean) };
  }

  const g = a.growth, pg = a.priorGrowth;
  if (g == null || pg == null || !isFinite(g) || !isFinite(pg)) return { state: "no-lookback" };

  const span = resilienceSpan(a.quarterly);
  const stable = g >= 0 && pg >= 0;
  const falling = g < 0 && pg < 0;
  const thin = (a.coverage != null && a.coverage < LOW_PRICED_COVERAGE)
    || (a.priorCoverage != null && a.priorCoverage < LOW_PRICED_COVERAGE);
  return {
    state: stable ? "stable" : falling ? "falling" : "mixed",
    label: stable ? "Stable/up " + span : falling ? "Falling " + span : "Mixed",
    thin,
  };
}
