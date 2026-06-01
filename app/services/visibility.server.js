// The core of the product: detect whether a brand shows up in an AI answer,
// compute share-of-voice vs competitors, and turn it into a 0-100 score.
import prisma from "../db.server.js";
import { askEngine } from "./ai-engines.server.js";

/**
 * Detect brand + competitor mentions in an AI answer.
 *
 * Matching is case-insensitive whole-word-ish (substring on a normalized
 * string). Position = rank of the brand's first mention among ALL brands
 * mentioned (1 = mentioned first). Null position means the brand is absent.
 *
 * @param {string} answer       the AI's answer text
 * @param {string} brandName    the merchant's brand
 * @param {string[]} competitors competitor brand names
 * @returns {{appeared: boolean, position: number|null, competitorsFound: string[]}}
 */
export function detectMentions(answer, brandName, competitors = []) {
  const hay = (answer ?? "").toLowerCase();

  const firstIndex = (name) => {
    if (!name) return -1;
    return hay.indexOf(name.toLowerCase());
  };

  const brandIdx = firstIndex(brandName);
  const appeared = brandIdx !== -1;

  const competitorsFound = competitors.filter((c) => firstIndex(c) !== -1);

  let position = null;
  if (appeared) {
    // Rank brand among everyone mentioned, ordered by where they first appear.
    const mentioned = [{ name: brandName, idx: brandIdx }];
    for (const c of competitorsFound) {
      mentioned.push({ name: c, idx: firstIndex(c) });
    }
    mentioned.sort((a, b) => a.idx - b.idx);
    position = mentioned.findIndex((m) => m.name === brandName) + 1;
  }

  return { appeared, position, competitorsFound };
}

/**
 * Aggregate per-keyword results into a single 0-100 visibility score.
 *
 * Appearance rate is the backbone; a small bonus rewards top-ranked mentions
 * so "always #1" beats "always last". Fully explainable to a merchant.
 *
 * @param {{appeared: boolean, position: number|null}[]} results
 * @returns {number} 0-100
 */
export function scoreFromResults(results) {
  if (!results.length) return 0;

  let total = 0;
  for (const r of results) {
    if (!r.appeared) continue;
    // 70 pts just for showing up, +30 scaled by how high (cap rank at 5).
    const rank = Math.min(r.position ?? 5, 5);
    const rankBonus = ((5 - rank) / 4) * 30; // rank 1 -> +30, rank 5 -> 0
    total += 70 + rankBonus;
  }
  return Math.round(total / results.length);
}

/**
 * Run a full visibility check for one store on one engine:
 * query every keyword, detect mentions, persist a VisibilityCheck + results.
 *
 * @param {string} shopId
 * @param {"chatgpt"|"perplexity"} engine
 * @returns {Promise<{checkId: string, score: number}>}
 */
export async function runVisibilityCheck(shopId, engine) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { keywords: true, competitors: true },
  });
  if (!shop) throw new Error(`Shop ${shopId} not found`);
  if (!shop.keywords.length) throw new Error("Shop has no keywords configured");

  const competitorNames = shop.competitors.map((c) => c.name);
  const detections = [];

  for (const keyword of shop.keywords) {
    let answer = "";
    try {
      answer = await askEngine(engine, keyword.prompt);
    } catch (err) {
      console.error(`[visibility] ${engine} failed for "${keyword.prompt}":`, err.message);
    }
    const d = detectMentions(answer, shop.brandName, competitorNames);
    detections.push({ keyword, answer, ...d });
  }

  const score = scoreFromResults(detections);

  const check = await prisma.visibilityCheck.create({
    data: {
      shopId,
      engine,
      score,
      results: {
        create: detections.map((d) => ({
          keywordId: d.keyword.id,
          appeared: d.appeared,
          position: d.position,
          competitors: JSON.stringify(d.competitorsFound),
          rawResponse: d.answer.slice(0, 4000), // keep storage bounded
        })),
      },
    },
  });

  return { checkId: check.id, score };
}
