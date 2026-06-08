# Surfaced — AI Visibility Tracker for Shopify

Surfaced is an embedded Shopify app that measures how often AI search engines
(ChatGPT, Perplexity, DeepSeek, etc.) recommend a store when shoppers ask for
products in its niche, scores that visibility 0–100, shows the trend and
share-of-voice vs. competitors, and gives concrete actions to improve.

> Built measurement-first (the moat is measuring + proving ROI, not the
> commodity "optimization"). Target market: English-speaking (US) DTC stores,
> starting with the supplements / wellness niche. Freemium SaaS.

## Tech stack

- React Router 7 + Polaris **web components** (`<s-page>`, `<s-section>`, …)
- Prisma + SQLite (dev)
- Shopify CLI / App Bridge
- AI engines via the app **owner's** API key (merchants never bring their own):
  DeepSeek (cheapest), Perplexity (live web search), OpenAI (ChatGPT).

## Key files

| Path | What |
|------|------|
| `app/routes/app._index.jsx` | The whole dashboard (loader, action, UI, charts) |
| `app/services/ai-engines.server.js` | Connectors to DeepSeek / Perplexity / OpenAI + `defaultEngine()` |
| `app/services/visibility.server.js` | Brand detection, share-of-voice, 0–100 score, `runVisibilityCheck`, demo mode |
| `app/services/attribution.server.js` | Detect AI-sourced orders (currently disabled — see below) |
| `app/routes/webhooks.orders.create.jsx` | AI order attribution webhook (disabled) |
| `prisma/schema.prisma` | Shop, Competitor, Keyword, VisibilityCheck, VisibilityResult, OrderAttribution |

## Run locally (also: how to set up on a new machine)

> ⚠️ `.env` and `prisma/dev.sqlite` are **gitignored** — they are NOT on GitHub.
> On a new machine you must recreate the `.env` and rebuild the DB (steps below).

1. **Install prerequisites:** Node 20+ , Git, and the Shopify CLI
   (`npm i -g @shopify/cli`).
2. **Clone & install:**
   ```bash
   git clone <your-repo-url> surfaced
   cd surfaced
   npm install
   ```
3. **Create `.env`** in the project root with the AI key(s) (this file is the
   app owner's keys — never commit it):
   ```
   DEEPSEEK_API_KEY=sk-your-deepseek-key
   # PERPLEXITY_API_KEY=pplx-...   (optional, live web search)
   # OPENAI_API_KEY=sk-...         (optional)
   ```
4. **Set up the database** (migrations are committed; this rebuilds the local DB):
   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```
5. **Run it:**
   ```bash
   shopify app dev
   ```
   Open the preview URL, install on your dev store, and the dashboard
   auto-configures from the store and runs a first analysis.

## How it works

1. On load, the app reads the store (name + product types) and auto-configures
   brand, niche and keywords — zero effort onboarding.
2. It asks the AI engine buyer-intent questions (e.g. "what are the best
   <niche> brands"), nudging it to name specific brands.
3. It detects whether the store's brand appears, at what rank, and which
   competitors show up → a 0–100 Visibility Score + share-of-voice.
4. "Run analysis" again over time builds the trend.
5. Without an API key, a clearly-labeled **demo mode** runs so you can see the
   full flow.

## Current status / next steps

- ✅ Dashboard, scoring, charts, recommendations, demo mode, DeepSeek engine,
  English UI.
- ⏸️ **AI order attribution is disabled**: the `orders/create` webhook and
  `read_orders` scope need Shopify "protected customer data" approval. Re-enable
  by uncommenting the two blocks in `shopify.app.toml` after requesting access
  in the Dev Dashboard, then redeploy.
- ⏭️ Next ideas: auto-discover competitors from AI answers; trend over real
  scheduled runs; billing/plans; add Perplexity for live web search.
