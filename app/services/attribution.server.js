// Decide whether a Shopify order came from an AI search engine, by inspecting
// the order's referrer / landing URL. This is what turns "visibility" into
// proven revenue — the ROI story that justifies the subscription.

const AI_PATTERNS = [
  { source: "chatgpt", patterns: ["chatgpt.com", "chat.openai.com", "openai.com"] },
  { source: "perplexity", patterns: ["perplexity.ai"] },
  { source: "gemini", patterns: ["gemini.google.com", "bard.google.com"] },
  { source: "copilot", patterns: ["copilot.microsoft.com"] },
  { source: "claude", patterns: ["claude.ai"] },
];

/**
 * Inspect an order webhook payload and return the AI source label, or null.
 * Checks the referring site, the landing URL, and any utm_source tag.
 *
 * @param {object} order  the orders/create webhook payload
 * @returns {string|null} "chatgpt" | "perplexity" | "gemini" | "copilot" | "claude" | null
 */
export function detectAiSource(order) {
  const text = [order?.referring_site, order?.landing_site, order?.landing_site_ref]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
    .join(" ");

  if (!text) return null;

  for (const { source, patterns } of AI_PATTERNS) {
    if (patterns.some((p) => text.includes(p))) return source;
    if (text.includes(`utm_source=${source}`)) return source;
  }
  return null;
}
