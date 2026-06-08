import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import { runVisibilityCheck } from "../services/visibility.server.js";

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
    ...sortedTypes.slice(0, 3).map((t) => `best ${t.toLowerCase()}`),
    ...(niche
      ? [`top rated ${niche.toLowerCase()} brands`, `best ${niche.toLowerCase()} 2026`]
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
    "best magnesium supplements",
    "best magnesium for sleep",
    "best supplements for women",
    "top rated supplement brands",
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
  const k = process.env.PERPLEXITY_API_KEY || process.env.OPENAI_API_KEY || "";
  return Boolean(k && !k.includes("REEMPLAZA"));
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
        include: { results: true },
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
      { name: full.brandName || "Tu marca", count: brandCount, isBrand: true },
      ...Object.entries(compCounts).map(([name, count]) => ({
        name,
        count,
        isBrand: false,
      })),
    ].sort((a, b) => b.count - a.count);
  }

  const attributions = full?.attributions ?? [];
  const aiRevenue = attributions.reduce((sum, a) => sum + a.totalPrice, 0);

  return {
    shopDomain,
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
      return { ok: false, error: `No pude leer tu tienda: ${err.message}` };
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
        return { ok: false, error: "Configura tu marca y keywords primero." };
      }
    }

    try {
      const { score } = await runVisibilityCheck(shop.id, engine, { demo });
      return { ok: true, ran: true, score, engine, demo };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: "Acción desconocida" };
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
  if (score == null) return "Sin medir todavía";
  if (score >= 67) return "Buena visibilidad";
  if (score >= 34) return "Visibilidad media";
  return "Visibilidad baja";
}

function suggestKeywords(niche) {
  const n = (niche ?? "").trim();
  if (!n) return [];
  return [
    `best ${n}`,
    `best ${n} for beginners`,
    `top rated ${n} brands`,
    `best ${n} 2026`,
    `best affordable ${n}`,
  ];
}

/* eslint-disable react/prop-types */
// Simple inline bar chart (no dependencies) for the score trend.
function TrendChart({ points }) {
  if (!points.length) {
    return <s-paragraph tone="subdued">Aún no hay análisis.</s-paragraph>;
  }
  const w = 520;
  const h = 180;
  const pad = 28;
  const n = points.length;
  const slot = (w - pad * 2) / n;
  const barW = Math.min(48, slot * 0.6);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: w }}>
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#dde" />
      {points.map((p, i) => {
        const barH = (p.score / 100) * (h - pad * 2);
        const x = pad + i * slot + (slot - barW) / 2;
        const y = h - pad - barH;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(barH, 2)}
              rx="4"
              fill={scoreColor(p.score)}
            />
            <text
              x={x + barW / 2}
              y={y - 5}
              fontSize="12"
              textAnchor="middle"
              fill="#444"
            >
              {p.score}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Horizontal bars for share of voice (you vs competitors).
function ShareChart({ rows }) {
  if (!rows.length) {
    return (
      <s-paragraph tone="subdued">
        Corre un análisis para ver cuánto apareces frente a tu competencia.
      </s-paragraph>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <s-stack direction="block" gap="base">
      {rows.map((r, i) => (
        <s-stack key={i} direction="block" gap="none">
          <s-text>
            {r.isBrand ? `★ ${r.name} (tú)` : r.name} — {r.count}
          </s-text>
          <div
            style={{
              background: "#eef0f2",
              borderRadius: 6,
              height: 16,
              width: "100%",
            }}
          >
            <div
              style={{
                width: `${(r.count / max) * 100}%`,
                background: r.isBrand ? "#1a7f37" : "#9aa0a6",
                height: 16,
                borderRadius: 6,
              }}
            />
          </div>
        </s-stack>
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
      fetcher.submit({ intent, engine: "perplexity" }, { method: "POST" });
    }
  }, [data.checksCount, data.hasApiKey, data.configured, fetcher]);

  useEffect(() => {
    if (fetcher.data?.saved) shopify.toast.show("Guardado ✓");
    if (fetcher.data?.ran)
      shopify.toast.show(`Análisis listo: ${fetcher.data.score}/100`);
    if (fetcher.data?.autofill)
      shopify.toast.show("Autocompletado desde tu tienda ✓");
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
      { intent: data.hasApiKey && data.configured ? "run" : "demo", engine: "perplexity" },
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

  return (
    <s-page heading="Surfaced — Visibilidad en IA">
      <s-button
        slot="primary-action"
        onClick={analyze}
        {...(analyzing ? { loading: true } : {})}
      >
        Actualizar análisis
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
              🧪 Estás viendo <s-text fontWeight="bold">datos de ejemplo</s-text>.
              Conecta una API key (Perplexity u OpenAI) para medir tu visibilidad
              real en la IA.
            </s-text>
          </s-box>
        </s-section>
      )}

      {/* ── Score principal ───────────────────────────────────────────── */}
      <s-section heading={`Visibilidad de ${data.brandName || "tu tienda"} en la IA`}>
        <s-stack direction="inline" gap="large" alignItems="center">
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="none" alignItems="center">
              <s-text variant="headingXl">{score != null ? `${score}` : "—"}</s-text>
              <s-text tone="subdued">/ 100</s-text>
            </s-stack>
          </s-box>
          <s-stack direction="block" gap="tight">
            <s-badge tone={scoreTone(score)}>{statusLabel(score)}</s-badge>
            <s-paragraph>
              Mide qué tan seguido la IA (ChatGPT, Perplexity…) recomienda tu
              tienda cuando alguien busca productos como los tuyos.
            </s-paragraph>
            {data.latestRunAt && (
              <s-text tone="subdued">
                Último análisis: {new Date(data.latestRunAt).toLocaleString()}
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Gráfica de tendencia ──────────────────────────────────────── */}
      <s-section heading="Tendencia de tu visibilidad">
        <TrendChart points={data.trend} />
        <s-text tone="subdued">
          Cada barra es un análisis. Sube cuando la IA te recomienda más.
        </s-text>
      </s-section>

      {/* ── Share of voice ────────────────────────────────────────────── */}
      <s-section heading="Tú vs. tu competencia (share of voice)">
        <ShareChart rows={data.shareOfVoice} />
      </s-section>

      {/* ── ROI ───────────────────────────────────────────────────────── */}
      <s-section heading="Ventas atribuidas a IA">
        <s-stack direction="inline" gap="large">
          <s-box padding="large" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">{data.aiOrders}</s-text>
              <s-text tone="subdued">pedidos desde IA</s-text>
            </s-stack>
          </s-box>
          <s-box padding="large" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">${data.aiRevenue.toFixed(2)}</s-text>
              <s-text tone="subdued">ingresos desde IA</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* ── Ajustes (opcional) ────────────────────────────────────────── */}
      <s-section heading="Ajustes (opcional)">
        <s-paragraph tone="subdued">
          Configuramos esto automáticamente desde tu tienda. Solo cámbialo si
          quieres afinar la marca, el nicho, los competidores o las keywords.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <s-button onClick={autofill} {...(autofilling ? { loading: true } : {})}>
            Volver a autocompletar desde mi tienda
          </s-button>
          <s-text-field
            label="Nombre de tu marca"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
          />
          <s-text-field
            label="Nicho"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
          />
          <s-text-area
            label="Competidores (una marca por línea)"
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
          />
          <s-text-area
            label="Keywords (una pregunta por línea)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => setKeywords(suggestKeywords(niche).join("\n"))}
              {...(niche.trim() ? {} : { disabled: true })}
            >
              Sugerir keywords
            </s-button>
            <s-button variant="primary" onClick={save} {...(saving ? { loading: true } : {})}>
              Guardar
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Histórico ─────────────────────────────────────────────────── */}
      <s-section slot="aside" heading="Cómo funciona">
        <s-ordered-list>
          <s-list-item>Leemos tu tienda y la configuramos sola.</s-list-item>
          <s-list-item>
            Le preguntamos a la IA por productos como los tuyos.
          </s-list-item>
          <s-list-item>
            Medimos si te recomienda y te damos un puntaje 0–100.
          </s-list-item>
          <s-list-item>Repítelo y verás tu tendencia en el tiempo.</s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
