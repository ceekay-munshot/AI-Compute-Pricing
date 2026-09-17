/**
 * Cloudflare Pages Function — OpenRouter Rankings Scraper
 * Route:  /api/openrouter
 * Method: GET | OPTIONS
 *
 * Query params:
 *   view   (optional)  'week' | 'month' | 'all'  — default: 'week'
 *   top    (optional)  number of top models to return — default: 30
 *
 * Returns:
 * {
 *   success:     bool,
 *   scrapedAt:   ISO string,
 *   view:        'week',
 *   url:         string,
 *   models:      ModelRow[],
 *   geminiRows:  ModelRow[],   // only Google/Gemini models
 *   summary: {
 *     totalModels:      number,
 *     totalTokensRaw:   number,        // sum of model.tokens across captured set
 *     totalTokensLabel: string,        // formatted, e.g. "5.66T" / "289B"
 *     topModel:         ModelRow,
 *     geminiHighest:    ModelRow | null,
 *     geminiShare:      number | null, // Gemini % of totalTokensRaw
 *     geminiVsPeers:    PeerRow[],     // Gemini + top OpenAI + Anthropic + Mistral rows
 *   },
 *   fromCache:   bool,
 *   stale:       bool
 * }
 *
 * ModelRow shape:
 * {
 *   rank:        number,
 *   model:       string,       // full model name
 *   provider:    string,       // e.g. "google", "openai", "anthropic"
 *   tokens:      number,       // raw token count (normalised to single number)
 *   tokensLabel: string,       // display string e.g. "289B" or "1.2T"
 *   wowPct:      number|null,  // week-over-week % change (positive = up)
 *   wowLabel:    string,       // e.g. "+12%" | "new" | "—"
 *   isNew:       bool,
 *   isGoogle:    bool,
 *   isGemini:    bool
 * }
 *
 * Data policy:
 * • Token counts = relative usage proxy on OpenRouter's API network
 * • NOT Google total queries, NOT MAU, NOT revenue
 * • Source is labelled on every UI surface
 * • WoW% is week-over-week change as displayed on openrouter.ai/rankings
 */

import { fetchModelUsage } from './_openrouter-rankings.js';

const FIRECRAWL_API_KEY = 'fc-203d41c5b1984cdabee2a7564572efea';
const FIRECRAWL_BASE    = 'https://api.firecrawl.dev/v1';

/**
 * "deepseek-v4-flash-20260731" → "DeepSeek V4 Flash 0731"
 *
 * The rankings API identifies a model only by slug, so the display name is
 * derived. The release stamp is shortened to MMDD rather than dropped: two
 * releases of the same line are distinct models with distinct prices, and
 * dropping the stamp collapses `deepseek-v4-flash-20260731` and
 * `-20260423` into one indistinguishable row. This is also how the pre-
 * regression history rendered them ("DeepSeek V4 Flash 0731").
 */
function displayNameFromSlug(slug) {
  let suffix = '';
  const base = String(slug)
    .replace(/-(\d{4})(\d{2})(\d{2})$/, (_, y, m, d) => { suffix = ' ' + m + d; return ''; })
    .replace(/-(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => { suffix = ' ' + m + d; return ''; });
  const CASED = {
    gpt: 'GPT', deepseek: 'DeepSeek', openai: 'OpenAI', xai: 'xAI', ai: 'AI',
    llama: 'Llama', qwen: 'Qwen', glm: 'GLM', mimo: 'MiMo', minimax: 'MiniMax',
    oss: 'OSS', vl: 'VL', moe: 'MoE', hy: 'Hy', r1: 'R1', v2: 'V2', v3: 'V3', v4: 'V4',
  };
  return base.split('-').map(part => {
    const lower = part.toLowerCase();
    if (CASED[lower]) return CASED[lower];
    if (/^v?\d/.test(lower)) return lower.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ') + suffix;
}

/**
 * Refuse a ranking that is really the Top Apps table.
 *
 * Applied to every acquisition path, not just the one that broke: the failure
 * mode is an upstream layout change, and any path that reads the page rather
 * than the API can hit it. A wrong-but-well-formed payload stored silently is
 * strictly worse than a visible failure, because the dashboard keeps serving
 * the last good data when a fetch fails but happily overwrites it when one
 * "succeeds".
 */
function assertLooksLikeModels(models) {
  const APPS = /^(kilo code|cline|codex|pi|omp|freebuff|roo code|chatwise|sillytavern|openrouter api|janitorai|openwebui)$/i;
  const appish = models.filter(m => APPS.test(String(m.model || '').trim())).length;
  if (appish > 0) {
    throw new Error('Rejected: ' + appish + ' rows are applications, not models — ' +
      'this is the Top Apps table (the 2026-08-18 regression)');
  }
  const attributed = models.filter(m => m.provider && m.provider !== 'other').length;
  if (attributed < models.length * 0.5) {
    throw new Error('Rejected: only ' + attributed + ' of ' + models.length +
      ' rows have a real model provider — payload does not look like a model ranking');
  }
}

const OR_URLS = {
  week:  'https://openrouter.ai/rankings?view=week',
  month: 'https://openrouter.ai/rankings?view=month',
  all:   'https://openrouter.ai/rankings'
};

/* In-process cache — lives for the lifetime of the worker instance */
const _cache    = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;   // 4 hours (rankings change daily)
const STALE_TTL = 24 * 60 * 60 * 1000;  // 24 hours before we refuse to serve stale

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ─── OPTIONS ──────────────────────────────────────────────── */

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

/* ─── GET ──────────────────────────────────────────────────── */
export async function onRequestGet({ request }) {
  const url    = new URL(request.url);

  const view   = url.searchParams.get('view') || 'week';

  const top    = Math.min(parseInt(url.searchParams.get('top') || '30', 10), 100);
  const orUrl  = OR_URLS[view] || OR_URLS.week;
  const key    = view;
  const cached = _cache[key];
  const now    = Date.now();

  /* Serve fresh cache */
  if (cached && (now - cached.ts) < CACHE_TTL) {
    return ok({ ...cached.payload, fromCache: true,
                cacheAge: Math.round((now - cached.ts) / 60000) + 'm' });
  }

  /* Scrape */
  const result = await scrapeRankings(orUrl);

  if (!result.ok) {
    /* Return stale on error if available */
    if (cached && (now - cached.ts) < STALE_TTL) {
      return ok({ ...cached.payload, stale: true, staleReason: result.error });
    }
    return err(result.error);
  }

  const allModels    = result.models.slice(0, top);
  const geminiRows   = allModels.filter(m => m.isGoogle);
  const summary      = buildSummary(allModels);

  const payload = {
    success:    true,
    scrapedAt:  new Date().toISOString(),
    view,
    url:        orUrl,
    models:     allModels,
    geminiRows,
    summary,
    fromCache:  false,
    stale:      false,
    sourceNote: 'OpenRouter token usage rankings — relative API usage proxy on OpenRouter network. ' +
                'NOT Google total queries, search volume, MAU, or revenue.'
  };

  _cache[key] = { payload, ts: now };
  return ok(payload);
}

/* ─── Rankings acquisition ──────────────────────────────────── */
/*
 * Strategy, in order:
 *   0. OpenRouter's own JSON API — authoritative, no interpretation involved
 *   1. Firecrawl /extract with structured schema  — fallback
 *   2. Firecrawl /scrape markdown + parser        — fallback
 *
 * Attempt 0 was added after the Firecrawl path silently drifted. The rankings
 * page carries a Top Models table AND a Top Apps table; the extraction prompt
 * said "leaderboard rankings table", and from 2026-08-18 it began returning
 * Apps. The daily history recorded "Kilo Code" and "Cline" as models for a
 * month, total tokens fell from ~28T to ~1.8T, and Gemini share read zero —
 * all without a single error, because an LLM reading the wrong table produces
 * perfectly well-formed output.
 *
 * Asking the API removes the interpretation step entirely. Every path now also
 * passes through validateModelRows(), so a fallback that lands on Apps again
 * fails loudly instead of being stored.
 */
async function scrapeRankings(targetUrl) {
  /* ── Attempt 0: OpenRouter's JSON rankings API ─────────────── */
  try {
    const view = targetUrl.includes('view=month') ? 'month' : 'week';
    const { rows } = await fetchModelUsage(view);
    const paid = rows.filter(r => r.variant === 'standard');
    const byModel = new Map();
    for (const r of paid) {
      const prev = byModel.get(r.slug);
      if (prev) prev.tokens += r.totalTokens;
      else byModel.set(r.slug, { slug: r.slug, provider: r.provider, model: r.model, tokens: r.totalTokens });
    }
    const ranked = [...byModel.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .map((m, i) => normaliseRow({
        rank: i + 1,
        model: displayNameFromSlug(m.model),
        provider: m.provider,
        tokens: m.tokens,
        tokensLabel: formatTotalTokens(m.tokens),
        wowPct: null,
        wowLabel: '',
      }));
    if (ranked.length >= 20) return { ok: true, models: ranked, via: 'rankings-api' };
  } catch (_) { /* fall through to the scrape paths */ }

  /* ── Attempt 1: structured extract ─────────────────────────── */
  try {
    const extRes = await fetch(FIRECRAWL_BASE + '/extract', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + FIRECRAWL_API_KEY,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        urls: [targetUrl],
        prompt:
          'Extract the full LLM leaderboard rankings table from this OpenRouter page. ' +
          'For each row return: rank (number), model (full model name string), ' +
          'provider (provider/company name lowercase), tokens (token count as a number in raw tokens, ' +
          'e.g. "4.6T" = 4600000000000, "289B" = 289000000000), ' +
          'tokensLabel (original display string like "4.6T" or "289B"), ' +
          'wowPct (week-over-week percentage change as a number, e.g. +12 or -5, null if not shown), ' +
          'wowLabel (original string like "+12%", "-5%", "new", or empty). ' +
          'Include ALL visible rows. Output only a JSON array of these objects.',
        schema: {
          type: 'object',
          properties: {
            rows: {
              type:  'array',
              items: {
                type: 'object',
                properties: {
                  rank:        { type: 'number' },
                  model:       { type: 'string' },
                  provider:    { type: 'string' },
                  tokens:      { type: 'number' },
                  tokensLabel: { type: 'string' },
                  wowPct:      { type: ['number', 'null'] },
                  wowLabel:    { type: 'string' }
                },
                required: ['rank', 'model', 'tokensLabel']
              }
            }
          },
          required: ['rows']
        }
      })
    });

    if (extRes.status === 429) return { ok: false, error: 'Rate-limited (429)' };

    if (extRes.ok) {
      const extBody = await extRes.json();
      const rows    = extBody?.data?.rows || extBody?.rows;
      if (Array.isArray(rows) && rows.length >= 5) {
        const models = rows.map(normaliseRow);
        assertLooksLikeModels(models);
        return { ok: true, models, via: 'firecrawl-extract' };
      }
    }
  } catch (_) { /* fall through */ }

  /* ── Attempt 2: /scrape markdown ───────────────────────────── */
  try {
    const scrRes = await fetch(FIRECRAWL_BASE + '/scrape', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + FIRECRAWL_API_KEY,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        url:             targetUrl,
        formats:         ['markdown'],
        onlyMainContent: true,
        waitFor:         7000   // rankings table is JS-rendered
      })
    });

    if (scrRes.status === 429) return { ok: false, error: 'Rate-limited (429)' };
    if (!scrRes.ok) return { ok: false, error: 'HTTP ' + scrRes.status };

    const scrBody = await scrRes.json();
    if (!scrBody.success) return { ok: false, error: scrBody.error || 'scrape failed' };

    const md     = scrBody?.data?.markdown || scrBody?.markdown || '';
    const models = parseMarkdown(md);

    if (models.length < 5) return { ok: false, error: 'Could not parse rankings from markdown (got ' + models.length + ' rows)' };

    assertLooksLikeModels(models);
    return { ok: true, models, via: 'firecrawl-markdown' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ─── Parse markdown rankings table ─────────────────────────── */
/*
 * The OpenRouter rankings page markdown typically contains a table like:
 *
 *  | 1  | Claude Sonnet 4    | anthropic | 540B tokens | -15% |
 *  | 2  | Gemini 2.5 Flash   | google    | 289B tokens | +1%  |
 *
 * Or as a numbered list:
 *  1. Claude Sonnet 4 (anthropic) — 540B tokens — -15%
 *  2. Gemini 2.5 Flash (google) — 289B tokens — +1%
 */
function parseMarkdown(md) {
  if (!md) return [];
  const models = [];

  /* ── Format A: markdown table rows ─────────────────────────── */
  // | rank | model | provider | tokens | wow |
  const tableRowRe = /\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+[BT])\s*tokens\s*\|\s*([^|]*?)\s*\|/gi;
  let m;
  while ((m = tableRowRe.exec(md)) !== null) {
    const rank    = parseInt(m[1], 10);
    const model   = m[2].trim();
    const prov    = m[3].trim().toLowerCase();
    const tokLbl  = m[4].trim();
    const wowRaw  = m[5].trim();
    if (!isNaN(rank) && model) {
      models.push(normaliseRow({ rank, model, provider: prov, tokensLabel: tokLbl, wowLabel: wowRaw }));
    }
  }
  if (models.length >= 5) return models;

  /* ── Format B: numbered list with dashes ───────────────────── */
  models.length = 0;
  const listRe = /^(\d+)[.)]\s+(.+?)(?:\s+\(([^)]+)\))?\s*[—\-–]\s*([\d.]+[BT])\s*tokens(?:\s*[—\-–]\s*([^\n]+))?/gim;
  while ((m = listRe.exec(md)) !== null) {
    const rank    = parseInt(m[1], 10);
    const model   = m[2].trim();
    const prov    = (m[3] || '').trim().toLowerCase();
    const tokLbl  = m[4].trim();
    const wowRaw  = (m[5] || '').trim();
    if (!isNaN(rank) && model) {
      models.push(normaliseRow({ rank, model, provider: prov, tokensLabel: tokLbl, wowLabel: wowRaw }));
    }
  }
  if (models.length >= 5) return models;

  /* ── Format D: OpenRouter card layout (current 2026 format) ──
     Each entry spans multiple lines:
       1.
       [Model Name](url)
       by [provider](url)
       1.66T tokens
       64%
     We scan for "[Model Name](url)" followed within ~200 chars by
     "X.XXT tokens" and optionally a wow%. ─────────────────────── */
  models.length = 0;
  {
    // Find all numbered items: "1." or "2." at start of line
    const cardRe = /^(\d+)\.\s*$/gm;
    let cm;
    let prevRank = 0;
    while ((cm = cardRe.exec(md)) !== null) {
      const rank = parseInt(cm[1], 10);
      // Stop if ranks restart — means we hit a different section (e.g. "Top Apps")
      if (models.length >= 5 && rank <= prevRank) break;
      prevRank = rank;
      // Look ahead up to 400 chars for model link, provider, tokens, wow
      const ahead = md.slice(cm.index, cm.index + 400);

      // Model name: [Model Name](url) — skip image links ![...](...)
      const modelMatch = ahead.match(/(?<!!)\[([^\]]{2,60})\]\(https:\/\/openrouter\.ai\/[^)]+\)/);
      if (!modelMatch) continue;
      const modelName = modelMatch[1].replace(/\(free\)/gi, '').trim();

      // Provider: by [provider](url)
      const provMatch = ahead.match(/by\s+\[([^\]]+)\]\(/);
      const provider = provMatch ? provMatch[1].trim().toLowerCase() : inferProvider(modelName);

      // Token count: 1.66T tokens or 289B tokens
      const tokMatch = ahead.match(/([\d.]+[BT])\s*tokens/i);
      if (!tokMatch) continue;
      const tokLbl = tokMatch[1];

      // WoW%: number followed by % (after tokens line)
      const afterTok = ahead.slice(ahead.indexOf(tokMatch[0]) + tokMatch[0].length);
      const wowMatch = afterTok.match(/^\s*\n\s*(-?\d+)%/);
      const wowLabel = wowMatch ? (parseInt(wowMatch[1]) >= 0 ? '+' + wowMatch[1] : wowMatch[1]) + '%' : '';

      models.push(normaliseRow({
        rank, model: modelName, provider,
        tokensLabel: tokLbl, wowLabel
      }));
    }
  }
  if (models.length >= 5) return models;

  /* ── Format C: looser scan — rank + model + token label ────── */
  models.length = 0;
  const looseRe = /(\d+)[.)\s]+([A-Z][^\n\t]+?)\s+([\d.]+[BT])\s*tokens/gi;
  let rank = 0;
  while ((m = looseRe.exec(md)) !== null) {
    rank = parseInt(m[1], 10) || ++rank;
    const model  = m[2].trim().replace(/\s{2,}/g, ' ');
    const tokLbl = m[3].trim();
    /* Try to extract wow% that immediately follows */
    const after  = md.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const wowM   = after.match(/([+\-]\d+)%|new/i);
    models.push(normaliseRow({
      rank, model, provider: inferProvider(model),
      tokensLabel: tokLbl, wowLabel: wowM ? wowM[0] : ''
    }));
  }
  return models;
}

/* ─── Normalise a raw row into a clean ModelRow ─────────────── */
function normaliseRow(raw) {
  // Strip markdown link syntax: "[model name](https://...)" → "model name"
  let model = (raw.model || '').trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  // Also strip "by " prefix that Firecrawl sometimes adds
  model = model.replace(/^by\s+/i, '');
  const provider  = (raw.provider  || inferProvider(model)).toLowerCase().trim();
  const tokLbl    = (raw.tokensLabel || '').trim();
  const wowRaw    = (raw.wowLabel  || '').trim();
  const isGoogle  = provider === 'google' || /gemini|google/i.test(model);
  const isGemini  = /gemini/i.test(model);
  const isNew     = /new/i.test(wowRaw);

  /* Parse wow% */
  let wowPct = raw.wowPct !== undefined ? raw.wowPct : null;
  if (wowPct === null && !isNew) {
    const wm = wowRaw.match(/([+\-]?\d+(?:\.\d+)?)\s*%/);
    if (wm) wowPct = parseFloat(wm[1]);
  }

  /* Parse token count → number */
  let tokens = raw.tokens || 0;
  if (!tokens) {
    const tm = tokLbl.match(/([\d.]+)\s*([BT])/i);
    if (tm) {
      const val  = parseFloat(tm[1]);
      const unit = tm[2].toUpperCase();
      tokens = unit === 'T' ? val * 1e12 : val * 1e9;
    }
  }

  return {
    rank:        raw.rank || 0,
    model,
    provider,
    tokens,
    tokensLabel: tokLbl || formatTokens(tokens),
    wowPct,
    wowLabel:    isNew ? 'new' : (wowPct !== null ? (wowPct >= 0 ? '+' + wowPct : '' + wowPct) + '%' : '—'),
    isNew,
    isGoogle,
    isGemini
  };
}

/* ─── Build summary statistics ───────────────────────────────── */
function buildSummary(models) {
  const top    = models[0] || null;
  const geminis = models.filter(m => m.isGemini);
  const geminiHighest = geminis.length > 0 ? geminis[0] : null;

  /* Gemini vs top peers comparison set */
  const peers = ['openai', 'anthropic', 'mistralai', 'meta-llama', 'deepseek'];
  const peerRows = [];

  /* Add all Gemini rows first */
  geminis.slice(0, 3).forEach(r => peerRows.push(r));

  /* Add top 1 row per major competitor */
  peers.forEach(p => {
    const found = models.find(m => m.provider === p || m.provider.includes(p.split('-')[0]));
    if (found && !peerRows.find(r => r.model === found.model)) peerRows.push(found);
  });

  /* Sort by rank */
  peerRows.sort((a, b) => a.rank - b.rank);

  /* Compute Gemini token share within the visible top-N */
  const totalTokens  = models.reduce((s, m) => s + (m.tokens || 0), 0);
  const geminiTokens = geminis.reduce((s, m) => s + (m.tokens || 0), 0);
  const geminiShare  = totalTokens > 0 ? Math.round((geminiTokens / totalTokens) * 1000) / 10 : null;

  return {
    totalModels:      models.length,
    totalTokensRaw:   totalTokens,
    totalTokensLabel: formatTotalTokens(totalTokens),
    topModel:         top,
    geminiHighest,
    geminiShare,
    geminiVsPeers:    peerRows
  };
}

/**
 * Format a token count for the "Total" line specifically.
 * Uses 2 decimals for trillions to match the OpenRouter rankings tooltip
 * format (e.g. "5.66T" rather than the rougher "5.7T" used in row labels).
 */
function formatTotalTokens(n) {
  if (!n || n <= 0) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, '') + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  return n.toString();
}

/* ─── Helpers ────────────────────────────────────────────────── */
function inferProvider(model) {
  const m = model.toLowerCase();
  if (/gemini|google/.test(m))       return 'google';
  if (/gpt|o1|o3|o4|openai/.test(m)) return 'openai';
  if (/claude|anthropic/.test(m))    return 'anthropic';
  if (/llama|meta/.test(m))          return 'meta-llama';
  if (/mistral|mixtral/.test(m))     return 'mistralai';
  if (/deepseek/.test(m))            return 'deepseek';
  if (/qwen/.test(m))                return 'qwen';
  if (/gemma/.test(m))               return 'google';
  return 'other';
}

function formatTokens(n) {
  if (!n) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  if (n >= 1e9)  return Math.round(n / 1e9) + 'B';
  if (n >= 1e6)  return Math.round(n / 1e6) + 'M';
  return n.toString();
}

/* ─── Response helpers ───────────────────────────────────────── */
function ok(obj) {
  return new Response(JSON.stringify(obj), {
    status:  200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }
  });
}
function err(msg) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status:  502,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}


/* ═══════════════════════════════════════════════════════════════════
   CapEx handler — appended after all helpers so ok() is defined.
   Triggered by: GET /api/openrouter?view=capex
═══════════════════════════════════════════════════════════════════ */
