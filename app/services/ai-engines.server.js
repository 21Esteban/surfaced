// Connectors to the AI engines we measure visibility on.
//
// IMPORTANT: to measure whether a brand shows up "when a user asks ChatGPT",
// we need answers grounded in live web/shopping data — NOT a raw LLM completion,
// which would hallucinate. So:
//   - Perplexity searches the web natively (best proxy for AI search).
//   - OpenAI uses the Responses API with the web_search tool enabled.
//
// API keys are the app owner's (a variable cost), read from env vars.

const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL ?? "sonar";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

/**
 * Ask Perplexity a buyer-intent question and return the answer text.
 * @param {string} prompt
 * @returns {Promise<string>} the answer text
 */
async function askPerplexity(prompt) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY is not set");

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Perplexity ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Ask ChatGPT (web-search grounded) and return the answer text.
 * @param {string} prompt
 * @returns {Promise<string>} the answer text
 */
async function askChatGPT(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      tools: [{ type: "web_search_preview" }],
      input: prompt,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  // The Responses API exposes a flattened text helper; fall back to walking output.
  if (typeof data.output_text === "string") return data.output_text;
  const parts = (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text);
  return parts.join("\n");
}

/**
 * Query an engine by name.
 * @param {"chatgpt"|"perplexity"} engine
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function askEngine(engine, prompt) {
  if (engine === "perplexity") return askPerplexity(prompt);
  if (engine === "chatgpt") return askChatGPT(prompt);
  throw new Error(`Unknown engine: ${engine}`);
}

export const SUPPORTED_ENGINES = ["perplexity", "chatgpt"];
