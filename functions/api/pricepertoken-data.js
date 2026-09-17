/**
 * Cloudflare Pages Function — PricePerToken Structured Data Fetcher
 * Route: /api/pricepertoken-data
 * Method: GET
 *
 * Fetches https://pricepertoken.com/_payload.json server-side and returns
 * a normalized flat array of model pricing rows. This is the structured
 * upstream source for the Model Pricing embed — not DOM scraping, not OCR.
 *
 * Nuxt serializes page data in a compact indexed format (the `devalue`
 * convention): `data` is an array where any value can be a number that
 * references another entry by index. We walk the index chain starting at
 * `data[0].data["pricing-data"]` → ShallowReactive wrapper → { results }
 * → array of row indices → each row's fields (mostly indexed too).
 *
 * Return shape:
 *   {
 *     success: true,
 *     fetchedAt: ISO timestamp,
 *     sourceUpdatedAt: ISO timestamp (latest updated_at across rows),
 *     count: number of rows with current pricing,
 *     rows: [
 *       {
 *         slug, model, modelName, provider, providerId,
 *         inputPricePer1M, outputPricePer1M,
 *         contextLength, hasCurrentPricing, updatedAt
 *       },
 *       ...
 *     ]
 *   }
 */

const TARGET_URL = 'https://pricepertoken.com/_payload.json';

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
      'Cache-Control': 'public, max-age=600',
      ...CORS,
    },
  });
}

/**
 * Resolve a value from the indexed `data` array. Numbers reference
 * another index; anything else is a literal.
 */
function resolve(data, ref) {
  if (typeof ref === 'number' && ref >= 0 && ref < data.length) {
    return data[ref];
  }
  return ref;
}

/**
 * Unwrap Nuxt devalue reactive markers: ["ShallowReactive", <idx>],
 * ["Reactive", <idx>], ["Ref", <idx>], etc. are 2-element arrays whose
 * first element is a string tag and second element is the real index.
 */
function unwrapReactive(data, v) {
  while (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'string' &&
    /^(Shallow)?(Reactive|Ref|ReadonlyRef)$/.test(v[0])
  ) {
    v = resolve(data, v[1]);
  }
  return v;
}

/**
 * Walk the Nuxt payload to extract the pricing rows.
 *
 * Observed shape (pricepertoken.com, Apr 2026):
 *   data[0]       = { data: 1, prerenderedAt: ... }
 *   data[1]       = ["ShallowReactive", 2]
 *   data[2]       = { "pricing-data": 3, "home-model-changelog": 8422 }
 *   data[3]       = { showAll: 4 }     (the pricing-data container)
 *   data[4]       = { results: 5 }
 *   data[5]       = [6, 28, 46, ...]   (row indices)
 *   data[<row>]   = { slug, model, provider_name, input_price_..., ... }
 *
 * Any link in the chain may be Reactive/ShallowReactive wrapped.
 */
function extractRows(data) {
  const root = data[0];
  if (!root || typeof root !== 'object') return [];

  // data[0].data -> state obj (with "pricing-data" key)
  let state = resolve(data, root.data);
  state = unwrapReactive(data, state);
  if (!state || typeof state !== 'object') return [];

  // state["pricing-data"] -> container { showAll?, results?, ... }
  let container = resolve(data, state['pricing-data']);
  container = unwrapReactive(data, container);
  if (!container || typeof container !== 'object') return [];

  // The results array may be one or two hops down. First try direct,
  // then walk any sibling keys that point to objects containing `results`.
  let results = null;
  if (container.results !== undefined) {
    results = resolve(data, container.results);
    results = unwrapReactive(data, results);
  } else {
    for (const k of Object.keys(container)) {
      const child = unwrapReactive(data, resolve(data, container[k]));
      if (child && typeof child === 'object' && child.results !== undefined) {
        results = unwrapReactive(data, resolve(data, child.results));
        break;
      }
    }
  }
  if (!Array.isArray(results)) return [];

  const rows = [];
  for (const rowIdx of results) {
    const row = resolve(data, rowIdx);
    if (!row || typeof row !== 'object') continue;
    rows.push({
      slug:             resolve(data, row.slug),
      model:            resolve(data, row.model),
      modelName:        resolve(data, row.model_name),
      provider:         resolve(data, row.provider_name),
      providerId:       resolve(data, row.provider_id),
      inputPricePer1M:  resolve(data, row.input_price_per_1m_tokens),
      outputPricePer1M: resolve(data, row.output_price_per_1m_tokens),
      contextLength:    resolve(data, row.context_length),
      hasCurrentPricing: resolve(data, row.has_current_pricing),
      updatedAt:        resolve(data, row.updated_at),
    });
  }
  return rows;
}

export async function onRequestGet({ request }) {
  try {
    const resp = await fetch(TARGET_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; gdash-pricing-fetcher/1.0) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      return jsonResp(
        { success: false, error: 'Upstream returned ' + resp.status },
        502
      );
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      return jsonResp(
        { success: false, error: 'Unexpected payload shape (not an array)' },
        502
      );
    }

    const rows = extractRows(data);
    if (!rows.length) {
      return jsonResp(
        { success: false, error: 'No rows parsed from payload' },
        502
      );
    }

    // Latest updated_at across all rows — use as source timestamp
    let sourceUpdatedAt = null;
    for (const r of rows) {
      if (typeof r.updatedAt === 'string' && (!sourceUpdatedAt || r.updatedAt > sourceUpdatedAt)) {
        sourceUpdatedAt = r.updatedAt;
      }
    }

    const priced = rows.filter(r => r.hasCurrentPricing && typeof r.inputPricePer1M === 'number');

    const url = new URL(request.url);
    const provider = url.searchParams.get('provider');
    const slug = url.searchParams.get('slug');
    let out = priced;
    if (provider) out = out.filter(r => (r.provider || '').toLowerCase() === provider.toLowerCase());
    if (slug)     out = out.filter(r => r.slug === slug);

    return jsonResp({
      success: true,
      fetchedAt: new Date().toISOString(),
      sourceUpdatedAt,
      count: out.length,
      totalModels: rows.length,
      rows: out,
    });
  } catch (err) {
    return jsonResp(
      { success: false, error: 'Fetch/parse failed: ' + err.message },
      502
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
