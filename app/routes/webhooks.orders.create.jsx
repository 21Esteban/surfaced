import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import { detectAiSource } from "../services/attribution.server.js";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Only record orders that came from an AI engine.
  const source = detectAiSource(payload);
  if (!source) return new Response();

  const shopRecord = await prisma.shop.findUnique({
    where: { shopDomain: shop },
  });
  if (!shopRecord) return new Response();

  const orderId = String(payload.admin_graphql_api_id ?? payload.id ?? "");

  // Webhooks can fire more than once — don't double-count an order.
  const existing = await prisma.orderAttribution.findFirst({
    where: { shopId: shopRecord.id, orderId },
  });
  if (existing) return new Response();

  await prisma.orderAttribution.create({
    data: {
      shopId: shopRecord.id,
      orderId,
      source,
      totalPrice:
        parseFloat(payload.total_price ?? payload.current_total_price ?? "0") || 0,
    },
  });

  return new Response();
};
