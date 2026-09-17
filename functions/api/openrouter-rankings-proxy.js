/**
 * Cloudflare Pages Function — OpenRouter Rankings Proxy
 * Route: /api/openrouter-rankings-proxy
 * Method: GET
 *
 * Fetches https://openrouter.ai/rankings?view=week and returns the full
 * page HTML with relative URLs intact. Companion catch-all proxy functions
 * at /_next/*, /api/frontend/*, /api/internal/*, /images/* forward those
 * requests to openrouter.ai so the page's JS can load chunks, fetch data,
 * and render the chart.
 *
 * Supports two section modes via ?section= query param:
 *   - top-models (default): shows only the Top Models stacked bar chart
 *   - market-share: shows only the Market Share stacked % chart + provider ranking
 */

const TARGET_URL = 'https://openrouter.ai/rankings?view=week';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const section = url.searchParams.get('section') || 'top-models';

    const resp = await fetch(TARGET_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!resp.ok) {
      return new Response('Upstream returned ' + resp.status, { status: 502 });
    }

    let html = await resp.text();

    // DO NOT rewrite URLs — keep them relative so they hit our proxy routes.
    // Note: Clerk auth errors appear in console but are suppressed by our
    // injected script and don't affect chart rendering. Clerk is loaded
    // dynamically from inside a bundled JS chunk, so it can't be stripped
    // from the HTML.

    // ── 1. Error suppression — runs before any other scripts ──
    const errorSuppress = `
<script>
// Suppress Clerk auth errors (domain-locked, will always fail on proxy)
window.addEventListener('unhandledrejection', function(e) { e.preventDefault(); });
window.addEventListener('error', function(e) {
  var msg = (e.message || '').toLowerCase();
  if (msg.indexOf('clerk') !== -1 || msg.indexOf('chunk') !== -1) {
    e.preventDefault();
    return true;
  }
});
// Periodically hide error overlays
var _clean = function() {
  var p = document.querySelector('nextjs-portal');
  if (p) p.remove();
  document.querySelectorAll('body > div').forEach(function(el) {
    var txt = el.innerText || '';
    if (txt.indexOf('Application error') !== -1 && !el.querySelector('svg.recharts-surface')) {
      el.style.display = 'none';
    }
  });
};
var _ival = setInterval(_clean, 300);
setTimeout(function(){ clearInterval(_ival); _clean(); }, 30000);
</script>`;

    // ── 2. Shared base CSS ──
    const baseCSS = `
/* === HIDE: page chrome === */
nav, header, footer,
[role="banner"], [role="navigation"], [role="contentinfo"],
aside { display: none !important; }
/* === HIDE: modals, toasts, promos, auth === */
[class*="cookie" i], [class*="toast" i], [class*="modal" i],
[class*="banner" i], [data-sonner-toaster],
[data-vaul-drawer], [data-vaul-overlay] { display: none !important; }
nextjs-portal { display: none !important; }
h1 { display: none !important; }
h1 + p { display: none !important; }
table, [role="table"] { display: none !important; }
.gap-12 > .flex-col:first-child > p { display: none !important; }
/* === BODY: clean embed === */
body {
  overflow-x: hidden !important;
  overflow-y: auto !important;
  margin: 0 !important;
  padding: 4px 8px 16px 4px !important;
  background: #fff !important;
}
body > div:first-child { min-height: unset !important; }
main, [role="main"] {
  max-width: 100% !important;
  padding: 0 4px !important;
  margin: 0 auto !important;
}
.recharts-wrapper { overflow: visible !important; }
svg.recharts-surface { overflow: visible !important; }
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
noscript { display: none !important; }
`;

    // ── 3. Section-specific CSS ──
    let sectionCSS;
    let sectionJS;

    if (section === 'market-share') {
      // Show ONLY the Market Share section.
      // DOM structure: section.main-content-container-lg has children:
      //   [0] div.gap-12 (Top Models + LLM Leaderboard) — NOT a scroll-mt-24
      //   [1] div.scroll-mt-24 (Market Share) — THIS is what we want
      //   [2+] div.scroll-mt-24 (Benchmarks, Categories, etc.)
      // For market-share, CSS hides the gap-12 wrapper (Top Models) and
      // clips body height so the iframe doesn't have excess empty space.
      // Scroll-mt-24 visibility is handled by JS.
      sectionCSS = `
.main-content-container-lg > .gap-12 { display: none !important; }
body { overflow: hidden !important; max-height: 810px !important; }
`;
      sectionJS = `
document.addEventListener('DOMContentLoaded', function() {
  function clipToMarketShare() {
    // Hide description
    var ps = document.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].textContent.indexOf('Based on real usage data') !== -1) {
        ps[i].style.display = 'none';
      }
    }
    // Use direct children of the main section container
    var mainSec = document.querySelector('section.main-content-container-lg') ||
                  document.querySelector('[class*="main-content"]');
    if (!mainSec) return;
    var kids = mainSec.children;
    for (var i = 0; i < kids.length; i++) {
      var cls = kids[i].className || '';
      var txt = kids[i].innerText || '';
      // Show only Market Share section, hide everything else
      if (txt.indexOf('Market Share') !== -1 && cls.indexOf('scroll-mt') !== -1) {
        kids[i].style.setProperty('display', 'flex', 'important');
      } else {
        kids[i].style.setProperty('display', 'none', 'important');
      }
    }
  }
  clipToMarketShare();
  setTimeout(clipToMarketShare, 2000);
  setTimeout(clipToMarketShare, 5000);
  setTimeout(clipToMarketShare, 10000);
});`;
    } else {
      // Default: show ONLY the first scroll-mt-24 section (Top Models)
      sectionCSS = `
.scroll-mt-24 ~ .scroll-mt-24 { display: none !important; }
.scroll-mt-24:first-of-type > div:nth-child(n+3) { display: none !important; }
`;
      sectionJS = `
document.addEventListener('DOMContentLoaded', function() {
  function clipToChart() {
    var ps = document.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].textContent.indexOf('Based on real usage data') !== -1) {
        ps[i].style.display = 'none';
      }
    }
    var sections = document.querySelectorAll('[class*="scroll-mt-24"]');
    for (var j = 1; j < sections.length; j++) {
      sections[j].style.display = 'none';
    }
    if (sections[0]) {
      var kids = sections[0].children;
      for (var k = 2; k < kids.length; k++) {
        kids[k].style.display = 'none';
      }
    }
  }
  clipToChart();
  setTimeout(clipToChart, 2000);
  setTimeout(clipToChart, 5000);
  setTimeout(clipToChart, 10000);
});`;
    }

    const cleanupCSS = `<style id="gdash-or-clean">${baseCSS}${sectionCSS}</style>`;
    const postCleanup = `<script>${sectionJS}</script>`;

    // ── 4. Inject into <head> ──
    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + errorSuppress);
    } else {
      html = errorSuppress + html;
    }

    if (html.includes('</head>')) {
      html = html.replace('</head>', cleanupCSS + postCleanup + '</head>');
    } else {
      html = cleanupCSS + postCleanup + html;
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response('Proxy error: ' + err.message, { status: 502 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
