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
 * Build a realistic fake AI answer for demo mode (no API key / no cost).
 * The brand shows up ~50% of the time at a random rank, so the resulting
 * score and history look believable — handy for testing and for screenshots.
 *
 * @param {string} keyword
 * @param {string} brandName
 * @param {string[]} competitors
 * @returns {string}
 */
export function generateDemoAnswer(keyword, brandName, competitors = []) {
  const pool = [...competitors];
  if (brandName && Math.random() < 0.5) pool.push(brandName);

  // Shuffle so the brand's position varies run to run.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const picks = pool.slice(0, Math.min(3, pool.length));
  if (!picks.length) return `There are several options for "${keyword}".`;

  const sentences = picks.map(
    (name, i) =>
      `${i === 0 ? "Top pick" : "Another option"}: ${name} is well-reviewed for this.`,
  );
  return `For "${keyword}", here are some recommendations. ${sentences.join(" ")}`;
}

/**
 * Run a full visibility check for one store on one engine:
 * query every keyword, detect mentions, persist a VisibilityCheck + results.
 *
 * @param {string} shopId
 * @param {"chatgpt"|"perplexity"} engine
 * @param {{demo?: boolean}} [options]  demo=true uses simulated answers (no API key)
 * @returns {Promise<{checkId: string, score: number}>}
 */
export async function runVisibilityCheck(shopId, engine, options = {}) {
  const { demo = false } = options;

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
    if (demo) {
      answer = generateDemoAnswer(keyword.prompt, shop.brandName, competitorNames);
    } else {
      try {
        answer = await askEngine(engine, keyword.prompt);
      } catch (err) {
        console.error(`[visibility] ${engine} failed for "${keyword.prompt}":`, err.message);
      }
    }
    const d = detectMentions(answer, shop.brandName, competitorNames);
    detections.push({ keyword, answer, ...d });
  }

  const score = scoreFromResults(detections);

  const check = await prisma.visibilityCheck.create({
    data: {
      shopId,
      engine: demo ? `${engine}-demo` : engine,
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
