import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import { runVisibilityCheck } from "../services/visibility.server.js";
import { defaultEngine } from "../services/ai-engines.server.js";

// ── server helpers ─────────────────────────────────────────────────────────

function parseLines(value) {
  return (value ?? "")
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Read the merchant's own store and derive brand, niche and keywords, so
// onboarding needs zero effort.
async function deriveStoreConfig(admin) {
  const resp = await admin.graphql(`#graphql
    query {
      shop { name }
      products(first: 50) { edges { node { productType } } }
    }`);
  const json = await resp.json();

  const brandName = (json.data?.shop?.name ?? "").trim();
  const types = (json.data?.products?.edges ?? [])
    .map((e) => (e.node?.productType ?? "").trim())
    .filter(Boolean);

  const freq = {};
  for (const t of types) freq[t] = (freq[t] ?? 0) + 1;
  const sortedTypes = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const niche = sortedTypes[0] ?? "";

  const kw = [
    ...sortedTypes.slice(0, 3).map((t) => `what are the best ${t.toLowerCase()} brands`),
    ...(niche
      ? [
          `recommend specific ${niche.toLowerCase()} brands`,
          `top rated ${niche.toLowerCase()} brands to buy`,
        ]
      : []),
  ];
  const keywords = [...new Set(kw)].slice(0, 6);

  return { brandName, niche, keywords, foundProducts: types.length };
}

async function applyConfig(shopDomain, { brandName, niche, keywords }) {
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { brandName, niche },
    create: { shopDomain, brandName, niche },
  });
  await prisma.keyword.deleteMany({ where: { shopId: shop.id } });
  if (keywords.length) {
    await prisma.keyword.createMany({
      data: keywords.map((prompt) => ({ shopId: shop.id, prompt })),
    });
  }
  return shop;
}

// Sample config so the demo always has something to analyze on a fresh store.
const DEMO_CONFIG = {
  brandName: "Terranova Wellness",
  niche: "magnesium supplements",
  competitors: ["Ritual", "AG1", "Thorne"],
  keywords: [
    "what are the best magnesium supplement brands",
    "best magnesium supplement brands for sleep",
    "recommend specific supplement brands for women",
    "top rated supplement brands to buy",
  ],
};

async function seedDemoConfig(shopDomain) {
  // Keep the store's real brand/niche if we already have them; only fill gaps.
  const existing = await prisma.shop.findUnique({ where: { shopDomain } });
  const brandName = existing?.brandName || DEMO_CONFIG.brandName;
  const niche = existing?.niche || DEMO_CONFIG.niche;
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { brandName, niche },
    create: { shopDomain, brandName, niche },
  });
  await prisma.competitor.deleteMany({ where: { shopId: shop.id } });
  await prisma.keyword.deleteMany({ where: { shopId: shop.id } });
  await prisma.competitor.createMany({
    data: DEMO_CONFIG.competitors.map((name) => ({ shopId: shop.id, name })),
  });
  await prisma.keyword.createMany({
    data: DEMO_CONFIG.keywords.map((prompt) => ({ shopId: shop.id, prompt })),
  });
  return shop;
}

function hasRealApiKey() {
  // eslint-disable-next-line no-undef
  const env = process.env;
  return Boolean(
    env.DEEPSEEK_API_KEY ||
      (env.PERPLEXITY_API_KEY && !env.PERPLEXITY_API_KEY.includes("REEMPLAZA")) ||
      env.OPENAI_API_KEY,
  );
}

// ── loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { competitors: true, keywords: true },
  });

  // Auto-configure from the store the first time (zero-effort onboarding).
  if (!shop || !shop.brandName) {
    try {
      const cfg = await deriveStoreConfig(admin);
      if (cfg.brandName || cfg.keywords.length) {
        await applyConfig(shopDomain, cfg);
      }
    } catch (e) {
      console.error("[loader] auto-config failed:", e.message);
    }
  }

  const full = await prisma.shop.findUnique({
    where: { shopDomain },
    include: {
      competitors: true,
      keywords: true,
      checks: {
        orderBy: { runAt: "desc" },
        take: 12,
        include: { results: { include: { keyword: true } } },
      },
      attributions: { orderBy: { createdAt: "desc" }, take: 100 },
    },
  });

  const checks = full?.checks ?? [];
  const latestCheck = checks[0] ?? null;

  // Share of voice from the latest check: brand vs each competitor.
  let shareOfVoice = [];
  if (latestCheck && full) {
    const brandCount = latestCheck.results.filter((r) => r.appeared).length;
    const compCounts = {};
    for (const c of full.competitors) compCounts[c.name] = 0;
    for (const r of latestCheck.results) {
      let arr = [];
      try {
        arr = JSON.parse(r.competitors || "[]");
      } catch {
        arr = [];
      }
      for (const name of arr) if (name in compCounts) compCounts[name] += 1;
    }
    shareOfVoice = [
      { name: full.brandName || "Your brand", count: brandCount, isBrand: true },
      ...Object.entries(compCounts).map(([name, count]) => ({
        name,
        count,
        isBrand: false,
      })),
    ].sort((a, b) => b.count - a.count);
  }

  // Keywords where the brand showed up vs. where it didn't (= opportunities).
  const coveredKeywords = [];
  const missingKeywords = [];
  if (latestCheck) {
    for (const r of latestCheck.results) {
      const prompt = r.keyword?.prompt;
      if (!prompt) continue;
      (r.appeared ? coveredKeywords : missingKeywords).push(prompt);
    }
  }

  const attributions = full?.attributions ?? [];
  const aiRevenue = attributions.reduce((sum, a) => sum + a.totalPrice, 0);

  return {
    shopDomain,
    coveredKeywords,
    missingKeywords,
    brandName: full?.brandName ?? "",
    niche: full?.niche ?? "",
    competitors: full?.competitors.map((c) => c.name).join("\n") ?? "",
    keywords: full?.keywords.map((k) => k.prompt).join("\n") ?? "",
    // Newest-first list for the history; chronological for the trend chart.
    trend: checks
      .slice()
      .reverse()
      .map((c) => ({ score: c.score ?? 0, engine: c.engine, runAt: c.runAt })),
    latestScore: latestCheck?.score ?? null,
    latestEngine: latestCheck?.engine ?? null,
    latestRunAt: latestCheck?.runAt ?? null,
    checksCount: checks.length,
    shareOfVoice,
    aiOrders: attributions.length,
    aiRevenue,
    hasApiKey: hasRealApiKey(),
    engine: defaultEngine(),
    configured: Boolean(full?.brandName && full?.keywords?.length),
  };
};

// ── action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "autofill") {
    let cfg;
    try {
      cfg = await deriveStoreConfig(admin);
    } catch (err) {
      return { ok: false, error: `Couldn't read your store: ${err.message}` };
    }
    await applyConfig(shopDomain, cfg);
    return { ok: true, autofill: true, foundProducts: cfg.foundProducts };
  }

  if (intent === "save") {
    const brandName = (formData.get("brandName") ?? "").toString().trim();
    const niche = (formData.get("niche") ?? "").toString().trim();
    const competitors = parseLines(formData.get("competitors"));
    const keywords = parseLines(formData.get("keywords"));

    const shop = await prisma.shop.upsert({
      where: { shopDomain },
      update: { brandName, niche },
      create: { shopDomain, brandName, niche },
    });
    await prisma.competitor.deleteMany({ where: { shopId: shop.id } });
    await prisma.keyword.deleteMany({ where: { shopId: shop.id } });
    if (competitors.length) {
      await prisma.competitor.createMany({
        data: competitors.map((name) => ({ shopId: shop.id, name })),
      });
    }
    if (keywords.length) {
      await prisma.keyword.createMany({
        data: keywords.map((prompt) => ({ shopId: shop.id, prompt })),
      });
    }
    return { ok: true, saved: true };
  }

  if (intent === "run" || intent === "demo") {
    const engine = (formData.get("engine") ?? "perplexity").toString();
    const demo = intent === "demo";
    let shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { keywords: true },
    });

    const needsConfig = !shop?.brandName || !shop?.keywords?.length;
    if (needsConfig) {
      if (demo) {
        shop = await seedDemoConfig(shopDomain);
      } else {
        return { ok: false, error: "Set up your brand and keywords first." };
      }
    }

    try {
      const { score } = await runVisibilityCheck(shop.id, engine, { demo });
      return { ok: true, ran: true, score, engine, demo };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: "Unknown action" };
};

// ── client helpers ───────────────────────────────────────────────────────────

function scoreTone(score) {
  if (score == null) return "neutral";
  if (score >= 67) return "success";
  if (score >= 34) return "warning";
  return "critical";
}

function scoreColor(score) {
  if (score >= 67) return "#1a7f37";
  if (score >= 34) return "#bf8700";
  return "#cf222e";
}

function statusLabel(score) {
  if (score == null) return "Not measured yet";
  if (score >= 67) return "Good visibility";
  if (score >= 34) return "Medium visibility";
  return "Low visibility";
}

function suggestKeywords(niche) {
  const n = (niche ?? "").trim();
  if (!n) return [];
  return [
    `what are the best ${n} brands`,
    `recommend specific ${n} brands`,
    `top rated ${n} brands to buy`,
    `best ${n} brands 2026`,
    `best ${n} brands for the money`,
  ];
}

// Actionable AEO advice, prioritized by how the store is doing.
function improvementPlan(score) {
  const base = [
    {
      title: "Enrich your product descriptions",
      detail:
        "Use the exact terms people ask AI about: what it's for, benefits, and “for [need]”. AI recommends what it understands.",
    },
    {
      title: "Get reviews and mentions on other sites",
      detail:
        "AI leans heavily on Reddit, blogs and YouTube. Ask for reviews and aim to appear in “best [your product]” lists.",
    },
    {
      title: "Create content that answers buying questions",
      detail:
        "Publish answers to “best X for Y” on your blog. That's exactly what AI cites when recommending.",
    },
    {
      title: "Check your structured data",
      detail:
        "Make sure your products have a clear title, price, brand and reviews (Shopify generates some automatically).",
    },
  ];

  if (score == null)
    return { tone: "neutral", intro: "Run an analysis to see recommendations.", actions: [] };
  if (score < 34)
    return {
      tone: "critical",
      intro:
        "AI barely mentions you. The priority is to start showing up against your competitors.",
      actions: base,
    };
  if (score < 67)
    return {
      tone: "warning",
      intro: "You're on the right track, but you can climb higher.",
      actions: base,
    };
  return {
    tone: "success",
    intro: "Great visibility! Keep it up and keep an eye on your competitors.",
    actions: base.slice(0, 2),
  };
}

/* eslint-disable react/prop-types */

// Circular gauge for the visibility score — the hero visual.
function ScoreGauge({ score }) {
  const size = 184;
  const stroke = 18;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score ?? 0)) / 100;
  const color = score == null ? "#C9CCCF" : scoreColor(score);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{ width: 184, maxWidth: "100%" }}
      role="img"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#EEF0F2"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="49%"
        textAnchor="middle"
        fontSize="48"
        fontWeight="700"
        fill="#1f2125"
      >
        {score != null ? score : "—"}
      </text>
      <text x="50%" y="64%" textAnchor="middle" fontSize="14" fill="#6D7175">
        of 100
      </text>
    </svg>
  );
}

// Smooth area + line chart for the score trend over time.
function TrendChart({ points }) {
  if (!points.length) {
    return <s-paragraph tone="subdued">No analyses yet.</s-paragraph>;
  }
  const w = 560;
  const h = 200;
  const padX = 14;
  const padY = 22;
  const n = points.length;
  const x = (i) => (n === 1 ? w / 2 : padX + (i * (w - 2 * padX)) / (n - 1));
  const y = (v) => h - padY - (v / 100) * (h - 2 * padY);

  const line = points.map((p, i) => `${x(i)},${y(p.score)}`).join(" ");
  const area = `${x(0)},${h - padY} ${line} ${x(n - 1)},${h - padY}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: w }}>
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={padX} x2={w - padX} y1={y(g)} y2={y(g)} stroke="#EEF0F2" />
          <text x={0} y={y(g) + 4} fontSize="10" fill="#9aa0a6">
            {g}
          </text>
        </g>
      ))}
      <polygon points={area} fill="rgba(0,127,95,0.10)" />
      <polyline points={line} fill="none" stroke="#007F5F" strokeWidth="2.5" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.score)} r="3.5" fill="#007F5F" />
      ))}
    </svg>
  );
}

// Polished horizontal bars for share of voice (you vs competitors).
function ShareChart({ rows }) {
  if (!rows.length) {
    return (
      <s-paragraph tone="subdued">
        Run an analysis to see how you stack up against your competitors.
      </s-paragraph>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <s-stack direction="block" gap="base">
      {rows.map((r, i) => (
        <div key={i}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 4,
            }}
          >
            <span style={{ fontWeight: r.isBrand ? 700 : 400 }}>
              {r.isBrand ? `★ ${r.name} (you)` : r.name}
            </span>
            <span style={{ color: "#6D7175" }}>{r.count}</span>
          </div>
          <div style={{ background: "#EEF0F2", borderRadius: 8, height: 16 }}>
            <div
              style={{
                width: `${(r.count / max) * 100}%`,
                minWidth: r.count > 0 ? 10 : 0,
                background: r.isBrand ? "#007F5F" : "#C9CCCF",
                height: 16,
                borderRadius: 8,
              }}
            />
          </div>
        </div>
      ))}
    </s-stack>
  );
}

// ── page ──────────────────────────────────────────────────────────────────

export default function Index() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [brandName, setBrandName] = useState(data.brandName);
  const [niche, setNiche] = useState(data.niche);
  const [competitors, setCompetitors] = useState(data.competitors);
  const [keywords, setKeywords] = useState(data.keywords);
  const [showSettings, setShowSettings] = useState(false);

  const submittingIntent = fetcher.formData?.get("intent");
  const saving = fetcher.state !== "idle" && submittingIntent === "save";
  const analyzing =
    fetcher.state !== "idle" &&
    (submittingIntent === "run" || submittingIntent === "demo");
  const autofilling = fetcher.state !== "idle" && submittingIntent === "autofill";

  // Auto-run a first analysis on load so the merchant sees results with no
  // effort. Real if an API key is set, otherwise a clearly-labeled demo.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    if (data.checksCount === 0 && fetcher.state === "idle") {
      autoRan.current = true;
      const intent = data.hasApiKey && data.configured ? "run" : "demo";
      fetcher.submit({ intent, engine: data.engine }, { method: "POST" });
    }
  }, [data.checksCount, data.hasApiKey, data.configured, data.engine, fetcher]);

  useEffect(() => {
    if (fetcher.data?.saved) shopify.toast.show("Saved ✓");
    if (fetcher.data?.ran)
      shopify.toast.show(`Analysis ready: ${fetcher.data.score}/100`);
    if (fetcher.data?.autofill)
      shopify.toast.show("Auto-filled from your store ✓");
    if (fetcher.data?.error)
      shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  // Keep the form in sync with saved config (after autofill / demo seeding).
  useEffect(() => {
    setBrandName(data.brandName);
    setNiche(data.niche);
    setCompetitors(data.competitors);
    setKeywords(data.keywords);
  }, [data.brandName, data.niche, data.competitors, data.keywords]);

  const analyze = () =>
    fetcher.submit(
      {
        intent: data.hasApiKey && data.configured ? "run" : "demo",
        engine: data.engine,
      },
      { method: "POST" },
    );
  const save = () =>
    fetcher.submit(
      { intent: "save", brandName, niche, competitors, keywords },
      { method: "POST" },
    );
  const autofill = () => fetcher.submit({ intent: "autofill" }, { method: "POST" });

  const score = data.latestScore;
  const isDemo = (data.latestEngine ?? "").includes("demo") || !data.hasApiKey;
  const plan = improvementPlan(score);
  const covered = data.coveredKeywords.length;
  const totalKw = covered + data.missingKeywords.length;
  const delta =
    data.trend.length >= 2
      ? data.trend[data.trend.length - 1].score -
        data.trend[data.trend.length - 2].score
      : null;

  return (
    <s-page heading="Surfaced — AI Visibility">
      <s-button
        slot="primary-action"
        onClick={analyze}
        {...(analyzing ? { loading: true } : {})}
      >
        Run analysis
      </s-button>

      {isDemo && (
        <s-section>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-text tone="subdued">
              🧪 You're viewing <s-text fontWeight="bold">sample data</s-text>.
              Connect an API key to measure your real visibility in AI.
            </s-text>
          </s-box>
        </s-section>
      )}

      {/* ── Hero: gauge + summary ─────────────────────────────────────── */}
      <s-section heading={`How ${data.brandName || "your store"} shows up in AI`}>
        <s-stack direction="inline" gap="large" alignItems="center">
          <ScoreGauge score={score} />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="tight" alignItems="center">
              <s-badge tone={scoreTone(score)}>{statusLabel(score)}</s-badge>
              {delta != null && (
                <s-text tone={delta >= 0 ? "success" : "critical"}>
                  {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} vs. last analysis
                </s-text>
              )}
            </s-stack>
            {totalKw > 0 ? (
              <s-paragraph>
                AI recommends you in{" "}
                <s-text fontWeight="bold">
                  {covered} of {totalKw}
                </s-text>{" "}
                searches in your niche.
              </s-paragraph>
            ) : (
              <s-paragraph>
                Measures how often AI recommends your store when someone searches
                for products like yours.
              </s-paragraph>
            )}
            {data.latestRunAt && (
              <s-text tone="subdued">
                Last analysis: {new Date(data.latestRunAt).toLocaleString()} ·
                engine {data.latestEngine}
              </s-text>
            )}
            {data.latestEngine === "deepseek" && (
              <s-text tone="subdued">
                DeepSeek answers from its training knowledge (no live web
                search). Add Perplexity to measure real-time search.
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Trend chart ───────────────────────────────────────────────── */}
      <s-section heading="Your visibility trend">
        <TrendChart points={data.trend} />
        <s-text tone="subdued">
          Each point is one analysis. The line rises as AI recommends you more
          often.
        </s-text>
      </s-section>

      {/* ── Share of voice ────────────────────────────────────────────── */}
      <s-section heading="You vs. your competitors (share of voice)">
        <ShareChart rows={data.shareOfVoice} />
      </s-section>

      {/* ── How to improve ────────────────────────────────────────────── */}
      <s-section heading="How to improve your visibility">
        <s-stack direction="block" gap="base">
          <s-badge tone={plan.tone}>{statusLabel(score)}</s-badge>
          <s-paragraph>{plan.intro}</s-paragraph>

          {data.missingKeywords.length > 0 && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="tight">
                <s-text fontWeight="bold">
                  Searches where you DON'T appear (your opportunities):
                </s-text>
                <s-unordered-list>
                  {data.missingKeywords.map((kw, i) => (
                    <s-list-item key={i}>{kw}</s-list-item>
                  ))}
                </s-unordered-list>
                <s-text tone="subdued">
                  Focus content and reviews on these queries to start showing up.
                </s-text>
              </s-stack>
            </s-box>
          )}

          {plan.actions.length > 0 && (
            <s-stack direction="block" gap="base">
              <s-text fontWeight="bold">Recommended actions:</s-text>
              {plan.actions.map((a, i) => (
                <s-stack key={i} direction="block" gap="none">
                  <s-text fontWeight="bold">
                    {i + 1}. {a.title}
                  </s-text>
                  <s-text tone="subdued">{a.detail}</s-text>
                </s-stack>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ── ROI ───────────────────────────────────────────────────────── */}
      <s-section heading="Sales attributed to AI">
        <s-stack direction="inline" gap="large">
          <s-box padding="large" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">{data.aiOrders}</s-text>
              <s-text tone="subdued">orders from AI</s-text>
            </s-stack>
          </s-box>
          <s-box padding="large" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">${data.aiRevenue.toFixed(2)}</s-text>
              <s-text tone="subdued">revenue from AI</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* ── Settings (optional, collapsed) ────────────────────────────── */}
      <s-section heading="Settings (optional)">
        <s-paragraph tone="subdued">
          We set this up automatically from your store. Open it only if you want
          to fine-tune your brand, niche, competitors or keywords.
        </s-paragraph>
        <s-button onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "Hide settings" : "Edit settings"}
        </s-button>

        {showSettings && (
          <s-stack direction="block" gap="base">
            <s-button onClick={autofill} {...(autofilling ? { loading: true } : {})}>
              Re-fill from my store
            </s-button>
            <s-text-field
              label="Your brand name"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            />
            <s-text-field
              label="Niche"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
            />
            <s-text-area
              label="Competitors (one brand per line)"
              value={competitors}
              onChange={(e) => setCompetitors(e.target.value)}
            />
            <s-text-area
              label="Keywords (one question per line)"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() => setKeywords(suggestKeywords(niche).join("\n"))}
                {...(niche.trim() ? {} : { disabled: true })}
              >
                Suggest keywords
              </s-button>
              <s-button variant="primary" onClick={save} {...(saving ? { loading: true } : {})}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {/* ── How it works (aside) ──────────────────────────────────────── */}
      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>We read your store and set it up for you.</s-list-item>
          <s-list-item>We ask AI about products like yours.</s-list-item>
          <s-list-item>
            We measure if it recommends you and give you a 0–100 score.
          </s-list-item>
          <s-list-item>Run it again to see your trend over time.</s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
