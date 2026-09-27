/**
 * Every function js/dashboard.jsx calls must actually exist.
 *
 * This exists because one did not, and it shipped. `afterChangeMark()` was
 * called on every Avg-view cell with a post-2026-07-10 basis — the Google and
 * OpenAI cells the source's change of measure touched — while its definition
 * had been removed. That is a ReferenceError at render, and it reached
 * production.
 *
 * Nothing caught it. `node --check` only parses. esbuild leaves an unresolved
 * identifier as a bare global rather than erroring, so the build succeeded. No
 * test rendered the dashboard, so the suite stayed green while the page was
 * broken.
 *
 * The specific hazard is a merge: one side deletes a helper AND its call sites
 * together (self-consistent), the other side keeps both (also self-consistent),
 * and resolving the conflicted hunks to one side restores the CALL while the
 * deletion of the DEFINITION merges cleanly because it sat in unconflicted
 * lines. Neither side was wrong on its own; the combination is.
 *
 * HOW IT WORKS. Comments and JSX text are full of prose that looks like a call
 * ("Primary GPUs (A100 …)"), so the source is first run through esbuild's JSX
 * transform — which turns JSX text into ordinary string arguments — and then
 * comments and string literals are stripped. What is left is code, and every
 * name called in it must resolve to an import, a declaration, a parameter, or a
 * known runtime global.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = ['js/dashboard.jsx', 'js/.dashboard-entry.jsx'];

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'await', 'async', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'yield',
  'case', 'with', 'super', 'import', 'export', 'instanceof', 'this']);

const GLOBALS = new Set(['require', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent',
  'fetch', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Promise',
  'Set', 'Map', 'WeakMap', 'Symbol', 'Error', 'RegExp', 'BigInt', 'alert', 'console',
  'structuredClone', 'queueMicrotask', 'reportError', 'Intl', 'URL', 'URLSearchParams', 'Response',
  'Request', 'Headers', 'Blob', 'File', 'FormData', 'AbortController', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
  'Image', 'Audio', 'Worker', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver',
  'CustomEvent', 'Event', 'Proxy', 'Reflect', 'globalThis', 'window', 'document', 'navigator',
  'localStorage', 'sessionStorage', 'location', 'history', 'performance', 'crypto']);

/** Whether a '/' at this point starts a regex literal rather than division. */
function isRegexStart(emittedSoFar) {
  const prev = emittedSoFar.replace(/\s+$/, '').slice(-1);
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

/**
 * JSX removed (so JSX text becomes string args), then comments and string
 * literals blanked.
 *
 * This must be a single left-to-right scan, not a sequence of regex replaces.
 * Stripping comments first lets a `/*` inside a string open a phantom comment
 * that swallows real declarations; stripping strings first lets a quote inside
 * a comment do the mirror-image damage. Either way the result silently loses
 * code and the check reports functions that plainly exist.
 */
function analysable(jsxSource) {
  const js = transformSync(jsxSource, { loader: 'jsx', jsx: 'automatic', minify: false }).code;
  let out = '';
  let i = 0;
  while (i < js.length) {
    const c = js[i], d = js[i + 1];
    if (c === '/' && d === '*') {                       // block comment
      const end = js.indexOf('*/', i + 2);
      i = end < 0 ? js.length : end + 2;
      out += ' ';
    } else if (c === '/' && d === '/') {                // line comment
      const end = js.indexOf('\n', i);
      i = end < 0 ? js.length : end;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {   // string / template
      const quote = c;
      i += 1;
      while (i < js.length && js[i] !== quote) i += js[i] === '\\' ? 2 : 1;
      i += 1;
      out += '""';
    } else if (c === '/' && isRegexStart(out)) {        // regex literal
      // A quarter pattern like /^(\d{4})-Q([1-4])$/ contains "Q(", which reads
      // as a call to an undefined Q if the literal is not skipped.
      i += 1;
      let inClass = false;
      while (i < js.length) {
        const ch = js[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;                    // not a regex after all
        i += 1;
      }
      i += 1;
      while (i < js.length && /[gimsuyd]/.test(js[i])) i += 1;
      out += '/x/';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function boundNames(src) {
  const bound = new Set();
  const add = (n) => { if (n) bound.add(n); };

  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]*['"]/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g)) add(n[2] || n[1]);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // destructuring, incl. const [a, setA] = useState() and const {x: y} = z
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[[{]([\s\S]{0,400}?)[\]}]\s*=/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) add(n[2] || n[1]);
  }
  for (const m of src.matchAll(/\(([^()]{0,400})\)\s*(?:=>|\{)/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) add(n[1]);
  }
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // object-literal method shorthand — a property, never a free identifier
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*\([^()]{0,200}\)\s*\{/g)) add(m[1]);
  return bound;
}

function undefinedCalls(jsxSource) {
  const src = analysable(jsxSource);
  const bound = boundNames(src);
  const called = new Set();
  // a call not preceded by a dot, so `.map(` and `obj.fn(` are excluded
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
  return [...called].filter(n => !bound.has(n) && !KEYWORDS.has(n) && !GLOBALS.has(n)).sort();
}

for (const rel of SOURCES) {
  test(`${rel} calls no function that does not exist`, () => {
    const missing = undefinedCalls(readFileSync(join(ROOT, rel), 'utf8'));
    assert.deepEqual(missing, [],
      'These names are called but never bound in ' + rel + '. Each is a ReferenceError\n' +
      'at render — esbuild will not complain and the build will succeed anyway.\n' +
      'If one is a legitimate runtime global, add it to GLOBALS in this test.');
  });
}

test('the detector actually catches the regression it was written for', () => {
  // The real broken revision, if this checkout has the history for it. Guards
  // against the test quietly degrading into one that can never fail.
  let broken;
  try {
    broken = execFileSync('git', ['show', 'cd30f3b~1:js/dashboard.jsx'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // Shallow clone or rewritten history — fall back to a synthetic case so the
    // detector is still proven to work.
    broken = 'function kept(){ return 1; }\nexport default function C(){ return <b>{kept()}{gone()}</b>; }\n';
    const synth = undefinedCalls(broken);
    assert.ok(synth.includes('gone'), 'detector missed a synthetic undefined call');
    assert.ok(!synth.includes('kept'), 'detector flagged a defined function');
    return;
  }
  assert.ok(undefinedCalls(broken).includes('afterChangeMark'),
    'the detector no longer catches the afterChangeMark regression it exists for');
});
