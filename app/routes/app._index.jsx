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
      { name: full.brandName || "Tu marca", count: brandCount, isBrand: true },
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
      title: "Enriquece tus descripciones de producto",
      detail:
        "Incluye los términos exactos que la gente le pregunta a la IA: para qué sirve, beneficios y “para [necesidad]”. La IA recomienda lo que entiende.",
    },
    {
      title: "Consigue reseñas y menciones en otros sitios",
      detail:
        "La IA confía mucho en Reddit, blogs y YouTube. Pide reseñas y busca aparecer en listas tipo “mejores [tu producto]”.",
    },
    {
      title: "Crea contenido que responda preguntas de compra",
      detail:
        "Publica en tu blog respuestas a “mejor X para Y”. Es justo lo que la IA cita al recomendar.",
    },
    {
      title: "Revisa tus datos estructurados",
      detail:
        "Asegúrate de que tus productos tengan título, precio, marca y reseñas bien definidos (Shopify genera parte automáticamente).",
    },
  ];

  if (score == null)
    return { tone: "neutral", intro: "Corre un análisis para ver recomendaciones.", actions: [] };
  if (score < 34)
    return {
      tone: "critical",
      intro:
        "La IA casi no te menciona. Lo prioritario es empezar a aparecer frente a tu competencia.",
      actions: base,
    };
  if (score < 67)
    return {
      tone: "warning",
      intro: "Vas por buen camino, pero puedes subir de posición.",
      actions: base,
    };
  return {
    tone: "success",
    intro: "¡Buena visibilidad! Mantén el ritmo y vigila a tu competencia.",
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
        de 100
      </text>
    </svg>
  );
}

// Smooth area + line chart for the score trend over time.
function TrendChart({ points }) {
  if (!points.length) {
    return <s-paragraph tone="subdued">Aún no hay análisis.</s-paragraph>;
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
        Corre un análisis para ver cuánto apareces frente a tu competencia.
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
              {r.isBrand ? `★ ${r.name} (tú)` : r.name}
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

      {/* ── Hero: medidor + resumen ───────────────────────────────────── */}
      <s-section heading={`Visibilidad de ${data.brandName || "tu tienda"} en la IA`}>
        <s-stack direction="inline" gap="large" alignItems="center">
          <ScoreGauge score={score} />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="tight" alignItems="center">
              <s-badge tone={scoreTone(score)}>{statusLabel(score)}</s-badge>
              {delta != null && (
                <s-text tone={delta >= 0 ? "success" : "critical"}>
                  {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} vs. análisis anterior
                </s-text>
              )}
            </s-stack>
            {totalKw > 0 ? (
              <s-paragraph>
                La IA te recomienda en{" "}
                <s-text fontWeight="bold">
                  {covered} de {totalKw}
                </s-text>{" "}
                búsquedas de tu nicho.
              </s-paragraph>
            ) : (
              <s-paragraph>
                Mide qué tan seguido la IA recomienda tu tienda cuando alguien
                busca productos como los tuyos.
              </s-paragraph>
            )}
            {data.latestRunAt && (
              <s-text tone="subdued">
                Último análisis: {new Date(data.latestRunAt).toLocaleString()} ·
                motor {data.latestEngine}
              </s-text>
            )}
            {data.latestEngine === "deepseek" && (
              <s-text tone="subdued">
                DeepSeek responde desde su conocimiento (sin búsqueda web en
                vivo). Suma Perplexity para medir la búsqueda en tiempo real.
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Gráfica de tendencia ──────────────────────────────────────── */}
      <s-section heading="Tendencia de tu visibilidad">
        <TrendChart points={data.trend} />
        <s-text tone="subdued">
          Cada punto es un análisis. La línea sube cuando la IA te recomienda
          más seguido.
        </s-text>
      </s-section>

      {/* ── Share of voice ────────────────────────────────────────────── */}
      <s-section heading="Tú vs. tu competencia (share of voice)">
        <ShareChart rows={data.shareOfVoice} />
      </s-section>

      {/* ── Cómo mejorar ──────────────────────────────────────────────── */}
      <s-section heading="Cómo mejorar tu visibilidad">
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
                  Búsquedas donde NO apareces (tus oportunidades):
                </s-text>
                <s-unordered-list>
                  {data.missingKeywords.map((kw, i) => (
                    <s-list-item key={i}>{kw}</s-list-item>
                  ))}
                </s-unordered-list>
                <s-text tone="subdued">
                  Enfoca contenido y reseñas en estas preguntas para empezar a
                  aparecer.
                </s-text>
              </s-stack>
            </s-box>
          )}

          {plan.actions.length > 0 && (
            <s-stack direction="block" gap="base">
              <s-text fontWeight="bold">Acciones recomendadas:</s-text>
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

      {/* ── Ajustes (opcional, colapsado) ─────────────────────────────── */}
      <s-section heading="Ajustes (opcional)">
        <s-paragraph tone="subdued">
          Configuramos esto automáticamente desde tu tienda. Ábrelo solo si
          quieres afinar la marca, el nicho, los competidores o las keywords.
        </s-paragraph>
        <s-button onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "Ocultar configuración" : "Editar configuración"}
        </s-button>

        {showSettings && (
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
        )}
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
