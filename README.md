# AI Compute Pricing

A standalone Cloudflare Pages dashboard for tracking the price of AI compute:
what a million tokens costs across frontier models, and what a GPU-hour costs
across the hardware those models run on.

It began as a **direct copy** of the pricing sections of
[`ceekay-munshot/google-dash`](https://github.com/ceekay-munshot/google-dash)
(at commit `863c950`), lifted out so price tracking has its own home instead of
sitting behind five other tabs. It reads the same data store, so the two
dashboards show identical numbers. The UI, sorting, tooltips and copy are
unchanged except where [Divergence from google-dash](#divergence-from-google-dash)
says otherwise.

---

## The three tabs

**Model Pricing** — the full model pricing table, the frontier
price-per-1M-tokens reference view, the peer matrix and the market-share
signal, plus the *Quality / Value Scatter* subtab.

**GPU Hardware Pricing** — `# AI Compute Pricing

A standalone Cloudflare Pages dashboard for tracking the price of AI compute:
what a million tokens costs across frontier models, and what a GPU-hour costs
across the hardware those models run on.

It began as a **direct copy** of the pricing sections of
[`ceekay-munshot/google-dash`](https://github.com/ceekay-munshot/google-dash)
(at commit `863c950`), lifted out so price tracking has its own home instead of
sitting behind five other tabs. It reads the same data store, so the two
dashboards show identical numbers. The UI, sorting, tooltips and copy are
unchanged except where [Divergence from google-dash](#divergence-from-google-dash)
says otherwise.

---

/GPU-hour month-on-month by GPU model, with both
subtabs: *Financial Correlation* and *Infra Monitoring*.

**Pricing History** — *Quarterly Model Pricing by Company*, the average `# AI Compute Pricing

A standalone Cloudflare Pages dashboard for tracking the price of AI compute:
what a million tokens costs across frontier models, and what a GPU-hour costs
across the hardware those models run on.

It began as a **direct copy** of the pricing sections of
[`ceekay-munshot/google-dash`](https://github.com/ceekay-munshot/google-dash)
(at commit `863c950`), lifted out so price tracking has its own home instead of
sitting behind five other tabs. It reads the same data store, so the two
dashboards show identical numbers. The UI, sorting, tooltips and copy are
unchanged except where [Divergence from google-dash](#divergence-from-google-dash)
says otherwise.

---

/1M
tokens block with its *Model-day weight* vs *Usage weighted* toggle, its *Avg /
QoQ / YoY* views and input/output split out; below it the reverse-proxied
pricepertoken.com/pricing-history chart. The quarterly block used to sit on
Model Pricing between the share signal and the live embed; the chart is new
here, carried over from google-dash's AI Adoption tab where it has always
lived. Neither was modified in the move.

---

## Divergence from google-dash

The rule elsewhere in this README — *a fix belongs in google-dash first* — still
holds for anything touching how a number is computed. These are the places this
repo has deliberately moved first, and they are all presentation:

- **The Pricing History tab.** google-dash has no such tab; its quarterly block
  sits on Model Pricing and its pricing-history chart sits on AI Adoption. Both
  components are carried over unmodified, only re-parented. Porting this back
  would mean adding a tab google-dash does not want.
- **The Price Resilience badge** on GPU → Financial Correlation reads
  *Stable/up* · *Mixed* · *Falling* where google-dash reads only *Stable/up* or
  *Falling*, and its period unit follows the month/quarter axis instead of
  always saying `2Q`. google-dash labelled a rising period "Falling" whenever
  the period before it dipped.
- **The header's fetched-at label** is generated at load instead of read from a
  build-time literal that had gone five months stale.

**Data and endpoints have not diverged in behaviour.** The three write-path
removals listed above are still the only backend differences, and
`functions/ppt-api/[[path]].js` is copied from google-dash unchanged.

---

## Shared KV, sole writer

This dashboard binds `HISTORY_KV` to namespace
`322b0ca12e874e6a8568126e182e59f5` — **google-dash's namespace**. That is
deliberate. It means:

- No pipeline to build, no backfill to run. Full history from 2026-04-21 is
  there the moment the binding is set.
- The two dashboards can never disagree, because there is only one set of
  numbers.

**google-dash is the sole writer.** Two deployments writing to one namespace
corrupts `index:days` and breaks *both* dashboards. So every write path in the
copied endpoints was removed here:

| Endpoint | Upstream behaviour | Here |
|---|---|---|
| `/api/gpu-hardware-pricing-history-refresh` | a `GET` writes `day:*` and `index:days` | **not deployed** |
| `/api/openrouter-model-usage` | a `GET` banks the current ISO week | read-through capture **disabled** |
| `/api/openrouter-chart-weekly` | `POST ?capture=1` writes the series | `POST` handler **removed** |

Those three files are the only place this repo diverges from google-dash on the
backend, and each carries a comment saying so. There are no capture scripts,
cron triggers, scheduled workers, seed files, fixtures, migrations or backfills
here, and **no `.github` directory at all**.

If a series looks stale, the fix belongs in google-dash. Not here.

---

## Third-party embeds need root-level asset routes

All three tabs embed a live third-party page through a reverse proxy, and those
proxies deliberately **do not rewrite URLs** for assets — the embedded page keeps
asking our own origin for its stylesheets, scripts and payload. That only works if a matching route
handler exists at the **root** of `functions/`, not under `functions/api/`:

| Route | Serves | Needed by |
|---|---|---|
| `functions/_nuxt/[[path]].js` | pricepertoken.com Nuxt JS, CSS, fonts | Model Pricing → Pricing Matrix (default view) **and** Pricing History |
| `functions/_payload.json.js` | pricepertoken.com hydration payload | same |
| `functions/static/[[path]].js` | getdeploying.com CSS, fonts, images, Alpine bundle | GPU Hardware Pricing → Infra Monitoring |
| `functions/ppt-api/[[path]].js` | api.pricepertoken.com JSON for the pricing-history chart | Pricing History → Open Router Pricing History |
| `functions/cdn-cgi/[[path]].js` | 204 sink for Cloudflare analytics beacons | all three embeds |
| `functions/ingest/[[path]].js` | 204 sink for PostHog analytics | all three embeds |

**These fail silently if missing**, and worse than a 404. The proxies inject error
suppression that swallows chunk / hydration / network errors, and an iframe's `onError`
cannot fire when the document itself returns HTTP 200. A missing root route does not even
404: Pages falls back to serving `index.html`, so the request returns **HTTP 200 with the
dashboard's own HTML in it** — an XHR expecting JSON throws in `JSON.parse` and the
suppression eats it. Measured on `/ppt-api/*` before its handler existed: 200, 384 KB,
the SPA shell. So there is no error card and no Retry button: the embed renders as raw
unstyled HTML with dead controls, or silently empty charts.

If you ever add another proxied embed, check what origin-relative URLs the upstream page
requests at runtime. A closed JS *import* graph does not prove a closed *route* graph.

Two root routes in google-dash are deliberately **not** carried over, because the embed
that needs them is out of scope: `_next/` and `images/` serve the OpenRouter rankings
embed (AI Adoption tab). `ppt-api/` was on that list until the Pricing History tab
landed — it serves the pricing-history chart and is now required.

---

## The 2026-07-28 basis change — this is not a bug

getdeploying.com changed its page layout on 2026-07-28. Before that date the
GPU price for a day was the **floor** (cheapest vendor); from that date it is
the **vendor median**. The long header comment in
`functions/api/_gpu-price-basis.js` has the full diagnosis.

Live production, `$`/GPU-hour, monthly:

| SKU | Apr-26 | May-26 | Jun-26 | Jul-26 | Aug-26 | Sep-26 |
|---|---|---|---|---|---|---|
| H100 | $0.54 | $0.89 | $0.58 | $0.40 | $3.42 | $3.34 |
| H200 | $0.36 | $0.82 | $0.97 | $0.96 | $4.40 | $4.38 |
| B200 | $2.23 | $2.20 | $2.25 | $2.38 | $6.59 | $6.48 |
| GB200 | $10.50 | $10.71 | $10.50 | $11.11 | $17.58 | $16.00 |
| A100 | $0.14 | $0.16 | $0.21 | $0.14 | $1.87 | $1.79 |
| L40S | $0.28 | $0.40 | $0.50 | $0.43 | $1.54 | $1.38 |
| **basis** | floor | floor | floor | floor | **median** | **median** |

`unpricedDays: 0`, `monthsMissing: []`. August is fully populated.

**Apr–Jul and Aug–Sep are not comparable.** The Jul→Aug step is a change of
unit, not a move in the market. `GPUFeedIntegrityBanner`, `renderFinBasisRow`
and `finBasisBoundaryIndex` exist specifically to surface this seam, and the
dashed boundary marker renders between Jul-26 and Aug-26.

Do not interpolate across the boundary, hide it, smooth it, or rewrite stored
KV snapshots. The table above is for verifying what the live API returns — it
is never hardcoded into the app.

---

## The usage-weight gate — expect withheld cells

`/api/openrouter-model-usage` currently reports `weeksStored: 0`. It banks the
full ~500-model ranking only on Mon/Tue, because that is when a trailing week
coincides with a completed ISO week. Until weeks accumulate,
`overlayRichModelWeeks()` in `provider-pricing-matrix.js` falls back to the
top-9 weekly chart, so usage-weighted coverage is low — OpenAI is measurable at
only 2–16% of its own volume — and some cells are withheld with a `gate` reason.

This is correct, intentional behaviour. The withheld cells and the coverage
labels are the honest answer. The thresholds in `_usage-weights.js` are:

```js
export const MIN_WEIGHTED_MODELS = 2;
export const MIN_COVERAGE        = 0.15;
export const MAX_TOP_WEIGHT_SHARE = 0.85;
```

Do not remove the gate, fabricate weights, or raise `MIN_COVERAGE` to force
cells through.

---

## Working on this repo

### You must run `npm run build` before committing

`index.html` is a **committed single-file artifact**: a hand-maintained head, an
inline bootstrap, and one minified esbuild IIFE bundle. `wrangler.toml` sets
`pages_build_output_dir = "./"`, so **Cloudflare runs no build**.

Editing `js/dashboard.jsx` alone changes nothing in production. The bundle must
be re-spliced into `index.html` and committed alongside the `.jsx` change:

```bash
npm install
npm run build        # re-splice the bundle into index.html
npm run build:check  # must print "index.html is up to date"
npm test             # 32/32
```

`npm run build:check` is deterministic, so it is a reliable staleness guard.
Run it before every commit.

### Layout

```
functions/api/     Cloudflare Pages Functions — the read-only API, over KV
functions/ppt-api/ root-level proxy for the pricing-history chart's own API
js/dashboard.jsx   the only React source (React 19 + Recharts)
js/.dashboard-entry.jsx  mounts it
index.html         committed pre-built artifact — regenerate, never hand-edit
scripts/build-dashboard.mjs  the splicer
```

`js/dashboard.jsx` is google-dash's lines 1-208 and 270-3555 spliced verbatim —
they occupy lines 1-208 and 209-3504 here — plus `PPTHistoryIframe` from its
lines 4950-4970, a second out-of-range splice taken so the pricing-history chart
could travel with the block it belongs to. The hand-written code is `App()` and
`PricingHistoryTab` at the end of that file; both carry header comments saying
so. See [Divergence from google-dash](#divergence-from-google-dash).

### Deliberately not built yet

Structural room is left for these; none of them exist:

- side-by-side comparison view
- forward curves (3M / 6M / 12M)
- cost-per-watt per GPU

---

## Cloudflare setup (one time)

There is no deploy workflow. Cloudflare Pages Git integration deploys on push,
the same way google-dash does.

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Select `ceekay-munshot/AI-Compute-Pricing`, production branch `main`
3. Framework preset **None**, build command **empty**, output directory `/`
   (`index.html` is pre-built and Cloudflare must **not** run a build)
4. Save and Deploy
5. Settings → Bindings → add KV namespace binding: variable name `HISTORY_KV`,
   namespace id `322b0ca12e874e6a8568126e182e59f5` — for **both Production and
   Preview**. Preview left unbound makes
   `/api/gpu-hardware-pricing-history`'s `env?.HISTORY_KV` guard show the
   "Quarter service temporarily unavailable" banner on preview deploys.
6. Redeploy once so the binding takes effect
7. Allowlist the resulting `*.pages.dev` domain

After that, every push to `main` auto-deploys. No further manual steps.
