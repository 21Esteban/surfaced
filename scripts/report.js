// Generate an AI-visibility report for a prospect, ready to paste into an
// outreach email. Uses the real DeepSeek engine.
//
// Usage:
//   1) Edit the PROSPECT object below (brand, niche, competitors).
//   2) Run:  DEEPSEEK_API_KEY=sk-... node scripts/report.js
//      (PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."; node scripts/report.js )
import { askEngine } from "../app/services/ai-engines.server.js";
import { detectMentions, scoreFromResults } from "../app/services/visibility.server.js";

// ── Edit this per prospect ───────────────────────────────────────────────────
const PROSPECT = {
  brand: "Moon Juice",
  niche: "adaptogen supplements",
  competitors: ["Gaia Herbs", "Thorne", "Ritual", "Goop", "Sun Potion"],
};
// ─────────────────────────────────────────────────────────────────────────────

const ENGINE = "deepseek";

function buildKeywords(niche) {
  const n = niche.toLowerCase();
  return [
    `what are the best ${n} brands`,
    `recommend specific ${n} brands`,
    `top rated ${n} brands to buy`,
    `best ${n} brands for the money`,
    `most trusted ${n} brands`,
  ];
}

const ACTIONS = [
  "Enrich product pages with the exact terms shoppers ask AI (use-cases, benefits, “for [need]”). AI recommends what it can clearly understand.",
  "Earn third-party mentions and reviews (Reddit, blogs, YouTube, “best of” lists). AI leans heavily on these to decide what to recommend.",
  "Publish content answering buyer questions (“best X for Y”) on your blog so AI has something to cite when recommending your category.",
];

function bar(score) {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

async function main() {
  const { brand, niche, competitors } = PROSPECT;
  const keywords = buildKeywords(niche);
  const results = [];
  const compCount = {};
  for (const c of competitors) compCount[c] = 0;

  for (const kw of keywords) {
    const prompt = `${kw}\n\nRecommend specific brands by name. List the brand names you would recommend.`;
    let answer = "";
    try {
      answer = await askEngine(ENGINE, prompt);
    } catch (e) {
      console.error("Engine error:", e.message);
    }
    const d = detectMentions(answer, brand, competitors);
    for (const c of d.competitorsFound) compCount[c] += 1;
    results.push({ kw, ...d });
  }

  const score = scoreFromResults(results);
  const covered = results.filter((r) => r.appeared);
  const missing = results.filter((r) => !r.appeared);
  const ranked = Object.entries(compCount)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const status =
    score >= 67 ? "Good" : score >= 34 ? "Needs work" : "Low — big opportunity";

  // ── Print the report ──
  const L = [];
  L.push("══════════════════════════════════════════════════");
  L.push(`  AI VISIBILITY REPORT — ${brand}`);
  L.push(`  Niche: ${niche}  ·  Engine: DeepSeek  ·  ${new Date().toLocaleDateString()}`);
  L.push("══════════════════════════════════════════════════");
  L.push("");
  L.push(`  VISIBILITY SCORE:  ${score}/100  [${bar(score)}]  (${status})`);
  L.push(`  You show up in ${covered.length} of ${results.length} AI buyer searches.`);
  L.push("");
  if (covered.length) {
    L.push("  ✓ WHERE YOU SHOW UP:");
    for (const r of covered) L.push(`     • "${r.kw}"  → rank #${r.position}`);
    L.push("");
  }
  if (missing.length) {
    L.push("  ✗ WHERE YOU'RE MISSING (opportunities):");
    for (const r of missing) L.push(`     • "${r.kw}"`);
    L.push("");
  }
  if (ranked.length) {
    L.push("  WHO AI RECOMMENDS MOST IN YOUR NICHE:");
    ranked.forEach(([name, n], i) =>
      L.push(`     ${i + 1}. ${name} — mentioned in ${n}/${results.length} searches`),
    );
    L.push("");
  }
  L.push("  TOP 3 ACTIONS TO IMPROVE:");
  ACTIONS.forEach((a, i) => L.push(`     ${i + 1}. ${a}`));
  L.push("");
  L.push("  — Generated with Surfaced (AI visibility for Shopify)");
  L.push("══════════════════════════════════════════════════");
  console.log(L.join("\n"));
}

main().then(() => process.exit(0));
