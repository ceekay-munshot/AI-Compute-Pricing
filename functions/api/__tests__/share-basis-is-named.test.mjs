/**
 * The share measure must be named on screen, on whichever measure is in force.
 *
 * The share series moved from the daily top-N captures to OpenRouter's weekly
 * provider series, because the daily one changed population on 2026-09-16 and
 * the weekly one never did. That fixed the comparison but changed what the
 * number COUNTS: all traffic including free tiers, and share of the whole
 * marketplace rather than share of the top N. Figures on the page move.
 *
 * ShareBasisNote returned null unless `basis.depth` was truthy. Depth exists
 * only on the daily measure — the weekly series is provider-level and
 * publishes depth null deliberately. So on the new measure the note rendered
 * NOTHING, and the page showed numbers that meant something different from the
 * day before with nothing saying so. Its sentence was hardcoded to the daily
 * measure as well, so had it rendered it would have described a measure no
 * longer in use.
 *
 * An unlabelled change of measure is worse than the break it replaced: a
 * reader can see a break, but cannot see a redefinition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = readFileSync(resolve(ROOT, 'js/dashboard.jsx'), 'utf8').replace(/\r\n/g, '\n');

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

const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const NOTE = code(fnSource('ShareBasisNote'));

test('the note does not disappear on the provider-weekly measure', () => {
  assert.doesNotMatch(NOTE, /if\(!basis\|\|!basis\.depth\)\s*return null;/,
    'gated on depth again — depth is null by design on the weekly series, so the ' +
    'basis note vanishes exactly when the measure has changed');
  assert.match(NOTE, /basis\.measureNote/,
    'the measure must come from the server, which is the only thing that knows which it used');
});

test('the sentence is not hardcoded to the daily measure', () => {
  assert.doesNotMatch(NOTE, /share of the top \{basis\.depth\}/,
    'the daily wording is back; on the weekly series it describes a measure not in force');
});

test('the newer exclusion reasons reach the reader', () => {
  // appNamed (Top-Apps days) and variantFiltered (paid-only days) are published
  // by the server; the note enumerated only the three original reasons.
  assert.match(NOTE, /x\.appNamed/, 'days listing apps rather than models are not accounted for');
  assert.match(NOTE, /x\.variantFiltered/, 'days counting paid traffic only are not accounted for');
});

test('a fallback to the daily captures is disclosed', () => {
  assert.match(NOTE, /basis\.fallback/,
    'if the weekly series could not be read, the reader is not told the page fell back');
});

test('the server publishes what the note needs, on both measures', async () => {
  // Guards the other half: the note can only say this if the API sends it.
  const src = readFileSync(resolve(ROOT, 'functions/api/pricing-share-signal.js'), 'utf8');
  for (const field of ['measureLabel', 'measureNote', 'fallbackReason', 'excludedDays']) {
    assert.ok(src.includes(field), 'pricing-share-signal.js no longer publishes ' + field);
  }
  assert.match(src, /appNamed/, 'the app-named exclusion counter is gone');
  assert.match(src, /variantFiltered/, 'the paid-only exclusion counter is gone');
});
