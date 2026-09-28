/**
 * Files meant to be identical in both dashboards must stay identical.
 *
 * google-dash and AI-Compute-Pricing read the same Cloudflare KV store and
 * publish overlapping figures. Several modules are deliberately the same file
 * in both, so the two sites cannot give different answers about the same data.
 *
 * They drifted anyway, and it reached readers. `_gpu-price-basis.js` gained a
 * linked-growth path on one side only: for the same SKU and the same month,
 * one dashboard printed +15.15% while the other printed a blank whose tooltip
 * said the two periods were "not comparable" — a statement its sibling
 * disproved with the same stored data. `pricing-history.js` drifted the other
 * way: one copy was rebuilt onto the measure-aware path while the other kept
 * publishing the 2026-07-10 change of measure as a price cut.
 *
 * A divergence here is not a merge conflict to resolve later. It is two
 * public answers to one question.
 *
 * If a file genuinely must differ, remove it from SHARED and say why — do not
 * relax the comparison.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_REPO = resolve(HERE, '../../..');
// The sibling checkout, when both are present side by side. In a lone
// checkout there is nothing to compare against and these are skipped rather
// than failed — a guard that fails for being alone teaches people to ignore it.
const SIBLING = resolve(THIS_REPO, '..', 'google-dash');

const SHARED = [
  'functions/api/_gpu-price-basis.js',
  'functions/api/_model-price-basis.js',
  'functions/api/_openrouter-rankings.js',
  'functions/api/pricing-history.js',
];

const haveSibling = existsSync(resolve(SIBLING, 'package.json'));

for (const rel of SHARED) {
  test(`${rel} matches the sibling dashboard`, { skip: haveSibling ? false : 'sibling checkout not present' }, () => {
    const mine = resolve(THIS_REPO, rel);
    const theirs = resolve(SIBLING, rel);
    assert.ok(existsSync(mine), rel + ' is missing from this repo');
    assert.ok(existsSync(theirs), rel + ' is missing from the sibling — it is meant to exist in both');

    const a = readFileSync(mine, 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(theirs, 'utf8').replace(/\r\n/g, '\n');
    if (a === b) return;

    // Name the first difference, so the failure is actionable rather than "they differ".
    const la = a.split('\n'), lb = b.split('\n');
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    assert.fail(
      rel + ' differs from the sibling dashboard at line ' + (i + 1) + '.\n' +
      '  this repo: ' + JSON.stringify((la[i] ?? '<end of file>').slice(0, 120)) + '\n' +
      '  sibling:   ' + JSON.stringify((lb[i] ?? '<end of file>').slice(0, 120)) + '\n' +
      'These files are shared so the two dashboards cannot disagree about the same\n' +
      'stored data. Port the change to both, or drop the file from SHARED with a reason.');
  });
}
