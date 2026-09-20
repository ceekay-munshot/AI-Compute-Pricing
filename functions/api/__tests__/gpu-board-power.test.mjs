/**
 * Guards for the board-power parser behind the $/kW-hr column.
 *
 * This column divides a price by a wattage scraped out of a third party's
 * markup. Every failure mode here produces a number that looks perfectly
 * reasonable — right units, right magnitude, wrong card — and nothing
 * downstream can tell. So the parser is required to refuse rather than guess,
 * and these cases pin the refusals.
 *
 * Fixtures are the shapes observed on getdeploying's live pages: an @graph
 * wrapper (reading the root as a Product matches nothing), values as strings
 * with a unit and a thousands separator ("1,200 W"), a "Specification variant"
 * on some cards and not others, and an offers.description that states the
 * price is per GPU — which is the only reason dividing by a per-GPU wattage is
 * legitimate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWatts,
  productNameMatches,
  boardPowerFromLdJson,
} from '../gpu-hardware-pricing-data.js';

const page = (product) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'BreadcrumbList' }, product, { '@type': 'FAQPage' }],
  })}</script></head><body></body></html>`;

const product = (over = {}) => ({
  '@type': 'Product',
  name: 'Nvidia H100 Cloud GPU',
  offers: { '@type': 'AggregateOffer', description: 'USD per GPU per hour, on-demand' },
  additionalProperty: [
    { '@type': 'PropertyValue', name: 'Board power', value: '700 W' },
    { '@type': 'PropertyValue', name: 'Specification variant', value: 'H100 SXM' },
  ],
  ...over,
});

/* ── parseWatts ── */

test('watts parse from the string form the source actually publishes', () => {
  assert.equal(parseWatts('700 W'), 700);
  assert.equal(parseWatts('1,200 W'), 1200);   // thousands separator is real
  assert.equal(parseWatts(' 350 W '), 350);
});

test('anything that is not <number> W is refused, never coerced', () => {
  // A silently coerced value here is a wrong $/kW under a correct label.
  for (const bad of ['700', '700 kW', '~700 W', '700-1000 W', 'W', '', 'n/a', null, undefined, 700]) {
    assert.equal(parseWatts(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

/* ── product matching ── */

test('the product name must match the SKU exactly, not by prefix', () => {
  assert.equal(productNameMatches('Nvidia H100 Cloud GPU', 'Nvidia H100'), true);
  // The trap: a prefix test passes here and would staple NVL board power onto
  // the H100 price. getdeploying does publish per-variant pages.
  assert.equal(productNameMatches('Nvidia H100 NVL Cloud GPU', 'Nvidia H100'), false);
  assert.equal(productNameMatches('Nvidia H200 Cloud GPU', 'Nvidia H100'), false);
});

/* ── end to end over a page ── */

test('board power and variant are read out of the @graph wrapper', () => {
  assert.deepEqual(boardPowerFromLdJson(page(product()), 'Nvidia H100'), {
    watts: 700,
    variant: 'H100 SXM',
  });
});

test('a card that publishes no variant still yields watts, with variant null', () => {
  const noVariant = product({
    name: 'Nvidia B200 Cloud GPU',
    additionalProperty: [{ '@type': 'PropertyValue', name: 'Board power', value: '1,000 W' }],
  });
  assert.deepEqual(boardPowerFromLdJson(page(noVariant), 'Nvidia B200'), {
    watts: 1000,
    variant: null,
  });
});

test('asking for the wrong SKU yields nothing rather than the page it landed on', () => {
  assert.equal(boardPowerFromLdJson(page(product()), 'Nvidia H200'), null);
});

test('a price that stops being per GPU blanks the figure instead of rescaling it', () => {
  // The GB200 superchip is ~2,700 W for two GPUs plus a Grace CPU. If the
  // source ever quoted per superchip, dividing a per-GPU price by it — or a
  // per-node price by a per-GPU wattage — would silently halve or double every
  // cell. Refusing is the only safe answer.
  const perNode = product({
    offers: { '@type': 'AggregateOffer', description: 'USD per node per hour, on-demand' },
  });
  assert.equal(boardPowerFromLdJson(page(perNode), 'Nvidia H100'), null);
});

test('a missing or malformed Board power yields nothing', () => {
  const noPower = product({ additionalProperty: [{ '@type': 'PropertyValue', name: 'Memory', value: '80 GB' }] });
  assert.equal(boardPowerFromLdJson(page(noPower), 'Nvidia H100'), null);

  const badPower = product({ additionalProperty: [{ '@type': 'PropertyValue', name: 'Board power', value: 'TBD' }] });
  assert.equal(boardPowerFromLdJson(page(badPower), 'Nvidia H100'), null);
});

test('markup with no usable JSON-LD yields nothing rather than throwing', () => {
  assert.equal(boardPowerFromLdJson('<html><body>nothing here</body></html>', 'Nvidia H100'), null);
  assert.equal(
    boardPowerFromLdJson('<script type="application/ld+json">{ not json </script>', 'Nvidia H100'),
    null,
  );
});

test('the regex is reusable across calls — a stale lastIndex would drop cards', () => {
  // LD_JSON_RE is a module-level /g regex; forgetting to reset lastIndex makes
  // the SECOND SKU of a run silently lose its watts.
  const html = page(product());
  assert.deepEqual(boardPowerFromLdJson(html, 'Nvidia H100'), { watts: 700, variant: 'H100 SXM' });
  assert.deepEqual(boardPowerFromLdJson(html, 'Nvidia H100'), { watts: 700, variant: 'H100 SXM' });
});
