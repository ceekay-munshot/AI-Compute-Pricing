/**
 * Stable Tracked Basket — Model Pricing History
 *
 * This is the canonical server-side definition of which models feed the
 * Quarterly Average Model Price summary. The basket is:
 *
 *   - Fixed. Changing it over time creates composition drift and breaks
 *     QoQ / YoY comparability. Keep it stable. Add new models only when
 *     you've thought about how that affects historical comparability.
 *
 *   - Equal-weighted. Every basket member contributes equally to the
 *     basket's daily / quarterly average. No usage weighting unless a
 *     reliable usage dataset is wired for this specific purpose.
 *
 *   - Matched by stable slug. Each basket entry is an exact pricepertoken
 *     slug. If a slug vanishes from a snapshot (delisted / renamed), that
 *     slug simply doesn't contribute — coverage drops for that day, and
 *     the UI surfaces the coverage ratio so the reader can judge.
 *
 *   - Broad enough to represent the market:
 *       8 providers × 1–4 flagship tiers each = 16 models.
 *
 * Adding / removing: treat this file like schema. When adding a new slug,
 * remember that it will have no history before the day you added it —
 * quarterly averages prior to that day will carry lower coverage.
 */

export const PRICING_BASKET = [
  // OpenAI flagship + mini + turbo + reasoning
  { slug: 'openai-gpt-4o',                      provider: 'OpenAI',      label: 'GPT-4o' },
  { slug: 'openai-gpt-4o-mini',                 provider: 'OpenAI',      label: 'GPT-4o mini' },
  { slug: 'openai-gpt-4-turbo',                 provider: 'OpenAI',      label: 'GPT-4 Turbo' },
  { slug: 'openai-o3',                          provider: 'OpenAI',      label: 'o3' },

  // Anthropic tiered
  { slug: 'anthropic-claude-3.5-sonnet',        provider: 'Anthropic',   label: 'Claude 3.5 Sonnet' },
  { slug: 'anthropic-claude-3-opus',            provider: 'Anthropic',   label: 'Claude 3 Opus' },
  { slug: 'anthropic-claude-3-haiku',           provider: 'Anthropic',   label: 'Claude 3 Haiku' },

  // Google Gemini flagship + fast
  { slug: 'google-gemini-2.5-pro',              provider: 'Google',      label: 'Gemini 2.5 Pro' },
  { slug: 'google-gemini-2.5-flash',            provider: 'Google',      label: 'Gemini 2.5 Flash' },

  // Mistral
  { slug: 'mistral-ai-mistral-large',           provider: 'Mistral AI',  label: 'Mistral Large' },
  { slug: 'mistral-ai-mistral-medium-3',        provider: 'Mistral AI',  label: 'Mistral Medium 3' },

  // DeepSeek
  { slug: 'deepseek-deepseek-r1-0528',          provider: 'Deepseek',    label: 'DeepSeek R1' },
  { slug: 'deepseek-deepseek-chat-v3-0324',     provider: 'Deepseek',    label: 'DeepSeek Chat v3' },

  // Cohere
  { slug: 'cohere-command-r',                   provider: 'Cohere',      label: 'Command R' },
  { slug: 'cohere-command-r-plus',              provider: 'Cohere',      label: 'Command R+' },

  // xAI
  { slug: 'xai-grok-3-beta',                    provider: 'Xai',         label: 'Grok 3' },
];

export const BASKET_SIZE = PRICING_BASKET.length;

/** Fast slug -> basket entry lookup */
export const BASKET_BY_SLUG = Object.fromEntries(
  PRICING_BASKET.map(b => [b.slug, b])
);
