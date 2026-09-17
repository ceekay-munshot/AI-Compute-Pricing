/**
 * Cloudflare Pages Function — Canonical History Read
 * Route: /api/history
 * Method: GET
 *
 * Reads canonical daily snapshots from Cloudflare KV. No auth required
 * (read-only, public data). Three derived views are supported, all
 * computed on-read from the daily source-of-truth (no stored derived data).
 *
 * Query params:
 *   ?view=daily      (default) — raw canonical daily snapshots
 *   ?view=weekly     — one representative snapshot per ISO week
 *   ?view=quarterly  — one representative snapshot per calendar quarter
 *   ?range=N         — number of days to scan (default 90, max 365)
 *   ?date=YYYY-MM-DD — return a single day's snapshot
 *   ?meta=true       — strip payload, return only metadata
 *
 * Response shape (range mode):
 *   {
 *     success, view, snapshots: [...], count,
 *     earliest, latest,
 *     // Weekly/quarterly views also include:
 *     periods: [{ id, start, end, dayCount, partial }, ...],
 *     trackingSinceDate
 *   }
 *
 * Derivation rules (see docstring on each helper below).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...CORS,
    },
  });
}

/* ──────────────────────────────────────────────────────────
   Period helpers — pure date math, no I/O
   ──────────────────────────────────────────────────────── */

/** Parse "YYYY-MM-DD" as a UTC Date (midnight) */
function parseDateUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * ISO 8601 week number of the year.
 * Weeks start Monday. Week 1 is the week containing the year's first Thursday.
 * A date can belong to a week in the previous or next year.
 * Returns { year, week } where year is the ISO week-year.
 */
function getISOWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Move to nearest Thursday: current date + 4 - current day-of-week (Mon=1..Sun=7)
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return { year: dt.getUTCFullYear(), week: weekNo };
}

/** "2026-W16" — ISO week key. */
function isoWeekKey(d) {
  const { year, week } = getISOWeek(d);
  return year + '-W' + String(week).padStart(2, '0');
}

/** Monday (start) and Sunday (end) of the ISO week containing d. */
function isoWeekRange(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = dt.getUTCDay() || 7; // Sun=0 → 7
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - (dow - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

/** Calendar quarter (1-4) and year. Q1 = Jan-Mar. */
function getQuarter(d) {
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}

/** "2026-Q2" — calendar quarter key. */
function quarterKey(d) {
  const { year, quarter } = getQuarter(d);
  return year + '-Q' + quarter;
}

/** First and last day of the calendar quarter containing d. */
function quarterRange(d) {
  const { year, quarter } = getQuarter(d);
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0)); // day 0 of next month = last day of this quarter
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/* ──────────────────────────────────────────────────────────
   Derivation logic
   ──────────────────────────────────────────────────────── */

/**
 * Group daily snapshots into periods, then pick one representative per period.
 *
 * Representative rule:
 *   "Latest captured day in the period." Whether or not it's a dedup pointer
 *   doesn't matter — `dedup:true` snapshots still carry full inline data
 *   (dedup is metadata, not a payload reference).
 *
 * Partial rule:
 *   A period is `partial: true` if today's date falls inside it. The period
 *   has not yet ended.
 *
 * @param dailies  Array of canonical daily snapshots (any order)
 * @param keyFn    fn(Date) -> period key string
 * @param rangeFn  fn(Date) -> { start, end } ISO date strings
 * @returns        Array of derived period snapshots, newest period first
 */
function derivePeriods(dailies, keyFn, rangeFn) {
  if (!dailies.length) return { periods: [], snapshots: [] };

  const todayKey = keyFn(new Date());
  const groups = new Map(); // key -> { snapshots[], range }

  for (const snap of dailies) {
    const dt = parseDateUTC(snap.date);
    const k = keyFn(dt);
    if (!groups.has(k)) {
      groups.set(k, { snapshots: [], range: rangeFn(dt) });
    }
    groups.get(k).snapshots.push(snap);
  }

  // Build period entries, sorted newest first
  const periods = [];
  const snapshots = [];

  const sortedKeys = Array.from(groups.keys()).sort().reverse();

  for (const periodId of sortedKeys) {
    const { snapshots: periodSnaps, range } = groups.get(periodId);
    periodSnaps.sort((a, b) => (a.date < b.date ? 1 : -1)); // date desc
    const dayCount = periodSnaps.length;
    const partial = periodId === todayKey;
    const distinctHashes = new Set(periodSnaps.map(s => s.hash)).size;

    // Representative: latest day in the period that has OR data, if any.
    // Falls back to latest day overall (may lack OR data — e.g. a gpu-refresh
    // snapshot that landed last). This matters because a period's KPI card
    // should reflect the strongest signal available for the period, not the
    // most recent no-op capture.
    const hasOR = s => !!(s && s.openrouterSummary && s.openrouterSummary.totalTokensRaw);
    const representativeWithOR = periodSnaps.find(hasOR) || null;
    const representative = representativeWithOR || periodSnaps[0];
    const orDayCount = periodSnaps.filter(hasOR).length;

    periods.push({
      id: periodId,
      start: range.start,
      end: range.end,
      dayCount,
      orDayCount,
      distinctHashes,
      partial,
    });

    snapshots.push({
      ...representative,
      periodId,
      periodStart: range.start,
      periodEnd: range.end,
      dayCount,
      orDayCount,
      distinctHashes,
      partial,
      // Flag for the client: was this period's representative chosen from an
      // OR-carrying snapshot (strong signal) or a fallback (weak signal)?
      representativeHasOR: !!representativeWithOR,
    });
  }

  return { periods, snapshots };
}

/* ──────────────────────────────────────────────────────────
   Main handler
   ──────────────────────────────────────────────────────── */

export async function onRequestGet({ request, env }) {
  const kv = env?.HISTORY_KV;
  if (!kv) {
    return jsonResp({
      success: false,
      error: 'HISTORY_KV not bound',
    }, 500);
  }

  const url = new URL(request.url);
  const view = (url.searchParams.get('view') || 'daily').toLowerCase();

  // ── Single-day mode ──
  const singleDate = url.searchParams.get('date');
  if (singleDate) {
    const snap = await kv.get('day:' + singleDate, 'json');
    if (!snap) {
      return jsonResp({ success: false, error: 'No snapshot for ' + singleDate }, 404);
    }
    return jsonResp({ success: true, snapshot: snap });
  }

  // ── Range mode ──
  const range = Math.min(parseInt(url.searchParams.get('range') || '90', 10), 365);
  const metaOnly = url.searchParams.get('meta') === 'true';

  const index = await kv.get('index:days', 'json') || [];

  if (!index.length) {
    return jsonResp({
      success: true,
      view,
      snapshots: [],
      periods: [],
      count: 0,
      earliest: null,
      latest: null,
      trackingSinceDate: null,
      message: 'No canonical history yet. Run /api/history-capture to create the first snapshot.',
    });
  }

  // For derived views, scan a wider window so we can produce meaningful
  // weekly/quarterly groupings even if `range` is small.
  const scanWindow = view === 'daily' ? range : Math.min(index.length, 365);
  const days = index.slice(0, scanWindow);

  // Fetch all daily snapshots in parallel
  const dailies = (await Promise.all(
    days.map(async (date) => kv.get('day:' + date, 'json'))
  )).filter(Boolean);

  // Earliest captured date is the tracking-start anchor
  const trackingSinceDate = dailies.length
    ? dailies.reduce((min, s) => (s.date < min ? s.date : min), dailies[0].date)
    : null;

  // ── Daily view ── (no derivation, original behavior preserved)
  if (view === 'daily') {
    const sliced = dailies.slice(0, range);
    const out = metaOnly ? sliced.map(toMeta) : sliced;
    return jsonResp({
      success: true,
      view: 'daily',
      snapshots: out,
      count: out.length,
      earliest: out.length ? out[out.length - 1].date : null,
      latest: out.length ? out[0].date : null,
      trackingSinceDate,
    });
  }

  // ── Weekly view ──
  if (view === 'weekly') {
    const { periods, snapshots } = derivePeriods(dailies, isoWeekKey, isoWeekRange);
    const out = metaOnly ? snapshots.map(toMeta) : snapshots;
    return jsonResp({
      success: true,
      view: 'weekly',
      snapshots: out,
      periods,
      count: out.length,
      earliest: out.length ? out[out.length - 1].periodStart : null,
      latest: out.length ? out[0].periodEnd : null,
      trackingSinceDate,
    });
  }

  // ── Quarterly view ──
  if (view === 'quarterly') {
    const { periods, snapshots } = derivePeriods(dailies, quarterKey, quarterRange);
    const out = metaOnly ? snapshots.map(toMeta) : snapshots;
    return jsonResp({
      success: true,
      view: 'quarterly',
      snapshots: out,
      periods,
      count: out.length,
      earliest: out.length ? out[out.length - 1].periodStart : null,
      latest: out.length ? out[0].periodEnd : null,
      trackingSinceDate,
    });
  }

  return jsonResp({
    success: false,
    error: 'Unknown view: ' + view + ' (use daily | weekly | quarterly)',
  }, 400);
}

function toMeta(snap) {
  return {
    date: snap.date,
    ts: snap.ts,
    hash: snap.hash,
    source: snap.source,
    authMethod: snap.authMethod,
    dedup: snap.dedup,
    sameAs: snap.sameAs,
    version: snap.version,
    periodId: snap.periodId,
    periodStart: snap.periodStart,
    periodEnd: snap.periodEnd,
    dayCount: snap.dayCount,
    distinctHashes: snap.distinctHashes,
    partial: snap.partial,
    orCount: snap.or?.length || 0,
    botsCount: snap.bots?.length || 0,
    trendsCount: snap.trends?.length || 0,
    hasFiling: !!snap.filing,
    // Small canonical metric — kept in meta-mode so the History tab and
    // monitors can compute QoQ without fetching the full payload.
    openrouterSummary: snap.openrouterSummary || null,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
