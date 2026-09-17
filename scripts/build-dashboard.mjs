#!/usr/bin/env node
/**
 * Rebuild the dashboard bundle inside index.html.
 *
 * index.html is a committed single-file artifact: a hand-maintained head +
 * inline bootstrap scripts, followed by one esbuild IIFE bundle of
 * js/.dashboard-entry.jsx (which pulls in js/dashboard.jsx, react, recharts).
 * Cloudflare Pages serves the repo root with NO build step — `pages_build_output_dir
 * = "./"` in wrangler.toml — so editing js/dashboard.jsx alone changes nothing in
 * production. This script is the missing compile step; run it and commit
 * index.html alongside the .jsx change.
 *
 *   node scripts/build-dashboard.mjs          # rewrite index.html
 *   node scripts/build-dashboard.mjs --check  # verify it is up to date
 *
 * The bundle is deterministic, so --check is a reliable CI/pre-commit guard
 * against shipping a source edit without the regenerated bundle.
 *
 * The bundle region is everything from the esbuild IIFE opener to the final
 * </script>. Everything before it (styles, the localStorage history-cache
 * bootstrap) is preserved byte-for-byte.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = resolve(ROOT, 'index.html');

// esbuild's minified IIFE always opens with this exact prologue. Anchoring on
// it (rather than a byte offset) keeps the splice correct if the inline
// bootstrap scripts above it ever grow or shrink.
const BUNDLE_OPENER = '(()=>{var ';

/**
 * A short content hash of the dashboard source, injected as __BUILD__ and used
 * as a cache key on the API fetches.
 *
 * The API caches its responses at the edge for six hours, which is what keeps
 * a 35MB upstream fan-out affordable. The cost is that a deploy could not
 * reach anyone until that cache expired — a fix would sit invisible for hours
 * while the old payload kept being served. An earlier attempt used a
 * five-minute time bucket instead, which gave every bucket its own cache key,
 * re-ran the fan-out constantly and took the upstream down.
 *
 * Hashing the SOURCE gets both: the key changes exactly once per code change,
 * so a deploy invalidates the cache once and then caches normally. It is
 * derived from file contents rather than a timestamp so the build stays
 * deterministic and `--check` remains a reliable guard.
 */
const BUILD_ID = createHash('sha256')
  .update(readFileSync(resolve(ROOT, 'js/dashboard.jsx')))
  .update(readFileSync(resolve(ROOT, 'js/.dashboard-entry.jsx')))
  .digest('hex')
  .slice(0, 8);

const result = await build({
  entryPoints: [resolve(ROOT, 'js/.dashboard-entry.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx' },
  // Without this, React bundles its development build: dev-only warnings,
  // no dead-code elimination and a materially slower render path shipped to
  // production. The committed bundle has always been a production build, so
  // omitting the define here would silently regress it on the next rebuild.
  define: { 'process.env.NODE_ENV': '"production"', __BUILD__: JSON.stringify(BUILD_ID) },
  // esbuild defaults to 'eof' when bundling; stated explicitly so a default
  // change upstream cannot quietly rewrite the whole file.
  legalComments: 'eof',
  write: false,
  absWorkingDir: ROOT,
  logLevel: 'warning',
});

const bundle = result.outputFiles[0].text;

const html = readFileSync(HTML, 'utf8');
const start = html.indexOf(BUNDLE_OPENER);
const end = html.lastIndexOf('</script>');
if (start < 0) throw new Error('Could not find the esbuild bundle opener in index.html');
if (end < start) throw new Error('Could not find the closing </script> after the bundle');

const next = html.slice(0, start) + bundle + html.slice(end);

if (process.argv.includes('--check')) {
  if (next === html) {
    console.log('index.html is up to date');
    process.exit(0);
  }
  console.error(
    'index.html is STALE — run `npm run build` and commit the result'
  );
  process.exit(1);
}

if (next === html) {
  console.log('index.html already up to date (bundle unchanged)');
} else {
  writeFileSync(HTML, next);
  console.log(
    'index.html rebuilt — bundle %d → %d bytes',
    end - start,
    bundle.length
  );
}
