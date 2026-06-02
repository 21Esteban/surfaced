import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import { runVisibilityCheck } from "../services/visibility.server.js";

// Split a textarea into clean lines (one competitor / keyword per line).
function parseLines(value) {
  return (value ?? "")
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: {
      competitors: true,
      keywords: true,
      checks: { orderBy: { runAt: "desc" }, take: 8 },
      attributions: { orderBy: { createdAt: "desc" }, take: 100 },
    },
  });

  const attributions = shop?.attributions ?? [];
  const aiRevenue = attributions.reduce((sum, a) => sum + a.totalPrice, 0);

  return {
    shopDomain,
    brandName: shop?.brandName ?? "",
    niche: shop?.niche ?? "",
    competitors: shop?.competitors.map((c) => c.name).join("\n") ?? "",
    keywords: shop?.keywords.map((k) => k.prompt).join("\n") ?? "",
    checks: shop?.checks ?? [],
    aiOrders: attributions.length,
    aiRevenue,
    configured: Boolean(shop?.brandName && shop?.keywords?.length),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

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

    // Replace competitors + keywords with the latest config.
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

  if (intent === "run") {
    const engine = (formData.get("engine") ?? "perplexity").toString();
    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop?.brandName) {
      return { ok: false, error: "Configura tu marca y keywords primero." };
    }
    try {
      const { score } = await runVisibilityCheck(shop.id, engine);
      return { ok: true, ran: true, score, engine };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: "Acción desconocida" };
};

function scoreTone(score) {
  if (score == null) return "neutral";
  if (score >= 67) return "success";
  if (score >= 34) return "warning";
  return "critical";
}

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
  const running = fetcher.state !== "idle" && submittingIntent === "run";

  useEffect(() => {
    if (fetcher.data?.saved) shopify.toast.show("Configuración guardada ✓");
    if (fetcher.data?.ran)
      shopify.toast.show(`Análisis listo: ${fetcher.data.score}/100`);
    if (fetcher.data?.error)
      shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const save = () =>
    fetcher.submit(
      { intent: "save", brandName, niche, competitors, keywords },
      { method: "POST" },
    );
  const run = (engine) =>
    fetcher.submit({ intent: "run", engine }, { method: "POST" });

  const latest = data.checks[0];
  const latestScore = latest?.score ?? null;

  return (
    <s-page heading="AI Visibility Tracker">
      <s-button
        slot="primary-action"
        onClick={() => run("perplexity")}
        {...(running ? { loading: true } : {})}
      >
        Analizar ahora
      </s-button>

      {/* ── Hero: el score que asusta y convierte ─────────────────────── */}
      <s-section heading="Tu visibilidad en búsquedas con IA">
        <s-stack direction="inline" gap="large" alignItems="center">
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="none" alignItems="center">
              <s-text variant="headingXl">
                {latestScore != null ? `${latestScore}` : "—"}
              </s-text>
              <s-text tone="subdued">/ 100</s-text>
            </s-stack>
          </s-box>
          <s-stack direction="block" gap="tight">
            <s-badge tone={scoreTone(latestScore)}>
              {latestScore == null
                ? "Sin medir todavía"
                : latestScore >= 67
                  ? "Buena visibilidad"
                  : latestScore >= 34
                    ? "Visibilidad media"
                    : "Visibilidad baja"}
            </s-badge>
            <s-paragraph>
              {data.configured
                ? "Pulsa “Analizar ahora” para medir si la IA recomienda tu tienda frente a tu competencia."
                : "Configura tu marca, nicho y keywords abajo para empezar a medir."}
            </s-paragraph>
            {latest && (
              <s-text tone="subdued">
                Último análisis: {new Date(latest.runAt).toLocaleString()} ·
                motor {latest.engine}
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── ROI: ventas atribuidas a IA ───────────────────────────────── */}
      <s-section heading="Ventas atribuidas a IA">
        <s-stack direction="inline" gap="large">
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">{data.aiOrders}</s-text>
              <s-text tone="subdued">pedidos desde IA</s-text>
            </s-stack>
          </s-box>
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="none">
              <s-text variant="headingLg">
                ${data.aiRevenue.toFixed(2)}
              </s-text>
              <s-text tone="subdued">ingresos desde IA</s-text>
            </s-stack>
          </s-box>
        </s-stack>
        <s-paragraph tone="subdued">
          Pedidos cuyo origen (referrer) es ChatGPT, Perplexity, Gemini, Copilot
          o Claude. Se registran automáticamente vía webhook al crearse la orden.
        </s-paragraph>
      </s-section>

      {/* ── Configuración / onboarding ────────────────────────────────── */}
      <s-section heading="Configuración">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Nombre de tu marca"
            details="Como aparece en respuestas de IA, ej. “Acme Coffee”"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
          />
          <s-text-field
            label="Nicho"
            details="Ej. “café de especialidad”"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
          />
          <s-text-area
            label="Competidores (uno por línea)"
            details="Marcas con las que compites por la recomendación de la IA"
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
          />
          <s-text-area
            label="Keywords / preguntas de compra (una por línea)"
            details="Ej. “mejores granos de café para espresso”"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={save}
              {...(saving ? { loading: true } : {})}
            >
              Guardar configuración
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Histórico ─────────────────────────────────────────────────── */}
      <s-section heading="Histórico de análisis">
        {data.checks.length === 0 ? (
          <s-paragraph tone="subdued">
            Aún no hay análisis. El histórico aparecerá aquí tras tu primer
            análisis.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="tight">
            {data.checks.map((c) => (
              <s-box
                key={c.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="none">
                    <s-text variant="headingMd">{c.score}/100</s-text>
                    <s-text tone="subdued">
                      {new Date(c.runAt).toLocaleString()}
                    </s-text>
                  </s-stack>
                  <s-badge tone={scoreTone(c.score)}>{c.engine}</s-badge>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* ── Motores ───────────────────────────────────────────────────── */}
      <s-section slot="aside" heading="Analizar por motor">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Mide tu visibilidad en cada motor de búsqueda con IA por separado.
          </s-paragraph>
          <s-button
            onClick={() => run("perplexity")}
            {...(running ? { loading: true } : {})}
          >
            Analizar en Perplexity
          </s-button>
          <s-button
            onClick={() => run("chatgpt")}
            {...(running ? { loading: true } : {})}
          >
            Analizar en ChatGPT
          </s-button>
          <s-text tone="subdued">
            Requiere configurar las API keys (PERPLEXITY_API_KEY /
            OPENAI_API_KEY) en el servidor.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
