/**
 * Route-graph guard for the reverse-proxied embeds.
 *
 * Every embed in this dashboard loads a third-party page whose assets and XHRs
 * keep pointing at our own origin, so each one needs a handler at the ROOT of
 * functions/. Twice now a port has shipped a component whose JS import graph
 * was closed while its runtime route graph was not — first the Model Pricing
 * and Infra Monitoring embeds, then the pricing-history chart.
 *
 * That failure is invisible in a browser. The proxies suppress chunk,
 * hydration and network errors, and a missing root route does not even 404:
 * Pages falls back to index.html, so the request returns HTTP 200 carrying the
 * dashboard's own HTML. An XHR expecting JSON throws inside JSON.parse and the
 * suppression swallows it. Measured on /ppt-api/* before its handler existed:
 * 200, 384 KB, the SPA shell.
 *
 * Hence a static test. It cannot prove the upstream still serves what we ask
 * for, but it does prove we did not delete or rename a route that an embed
 * depends on — which is the regression that actually happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FUNCTIONS = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(FUNCTIONS + rel, 'utf8');

/** Root-level routes, and the embed that dies silently without each. */
const ROOT_ROUTES = [
  ['_nuxt/[[path]].js', 'pricepertoken.com JS/CSS/fonts — Model Pricing and Pricing History'],
  ['_payload.json.js', 'pricepertoken.com hydration payload — Model Pricing and Pricing History'],
  ['static/[[path]].js', 'getdeploying.com assets — GPU Hardware Pricing / Infra Monitoring'],
  ['ppt-api/[[path]].js', 'api.pricepertoken.com JSON — Pricing History chart'],
  ['cdn-cgi/[[path]].js', '204 sink for Cloudflare beacons — all three embeds'],
  ['ingest/[[path]].js', '204 sink for PostHog — all three embeds'],
];

for (const [route, why] of ROOT_ROUTES) {
  test(`root route ${route} exists (${why})`, () => {
    assert.ok(
      existsSync(FUNCTIONS + route),
      `functions/${route} is missing. Without it the embed still returns HTTP 200 — ` +
        `Pages serves index.html instead — so nothing reports the failure.`
    );
  });
}

test('the history proxy rewrites the embed API base to /ppt-api', () => {
  const src = read('api/pricepertoken-history-proxy.js');
  assert.match(
    src,
    /\.join\('\/ppt-api'\)/,
    'The proxy no longer rewrites api.pricepertoken.com to /ppt-api. Either the ' +
      'rewrite moved, in which case update ROOT_ROUTES, or it was dropped and the ' +
      "embed's requests now leave our origin and fail CORS."
  );
});

test('the ppt-api proxy stays read-only — google-dash is the sole KV writer', () => {
  const src = read('ppt-api/[[path]].js');
  assert.doesNotMatch(
    src,
    /HISTORY_KV|env\s*\.\s*[A-Z_]+|\.put\s*\(/,
    'functions/ppt-api/[[path]].js touches a binding. It must stay a plain pass-through: ' +
      'two writers on the shared namespace corrupt index:days and break both dashboards.'
  );
});
