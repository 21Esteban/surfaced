// Offline sanity check of the detection + scoring logic (no API keys, no cost).
// Run: node scripts/test-detection.js
import { detectMentions, scoreFromResults } from "../app/services/visibility.server.js";

const brand = "Acme Coffee";
const competitors = ["Blue Bottle", "Stumptown", "Counter Culture"];

// A realistic AI answer to "best specialty coffee beans for espresso".
const answer = `
For espresso, a few standouts: Blue Bottle's Hayes Valley blend is rich and
chocolatey. Acme Coffee offers a single-origin Ethiopian that's bright and
balanced. Counter Culture's Hologram is another great pick for home baristas.
`;

const d1 = detectMentions(answer, brand, competitors);
console.log("Answer 1 (brand mentioned 2nd):", d1);

const d2 = detectMentions("Try Blue Bottle or Stumptown.", brand, competitors);
console.log("Answer 2 (brand absent):       ", d2);

const score = scoreFromResults([d1, d2]);
console.log("\nVisibility Score across the 2 prompts:", score, "/ 100");

// Quick assertions so a regression is obvious.
const ok =
  d1.appeared && d1.position === 2 &&
  d1.competitorsFound.length === 2 &&
  !d2.appeared && d2.position === null;
console.log(ok ? "\n✅ detection logic OK" : "\n❌ detection logic FAILED");
process.exit(ok ? 0 : 1);
