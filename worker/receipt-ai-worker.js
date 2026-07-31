const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEFAULT_MODEL = "gpt-5.6-luna";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI did not return JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeReceipt(receipt) {
  const amount = Number(receipt.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("No valid amount found");
  }

  return {
    date: typeof receipt.date === "string" ? receipt.date : "",
    amount,
    currency: receipt.currency === "HKD" ? "HKD" : "RMB",
    merchant: typeof receipt.merchant === "string" ? receipt.merchant : "",
    region: ["mainland", "macau", "hongkong", "overseas"].includes(receipt.region)
      ? receipt.region
      : "mainland",
    category: ["dining", "shopping", "travel", "other"].includes(receipt.category)
      ? receipt.category
      : "other",
    payment: ["applepay", "unionpay", "other"].includes(receipt.payment)
      ? receipt.payment
      : "other",
    confidence: Math.max(0, Math.min(Number(receipt.confidence || 0), 1)),
    note: typeof receipt.note === "string" ? receipt.note : "",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return json({ error: "Use POST /receipt" }, 405);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: "Missing OPENAI_API_KEY secret" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
      return json({ error: "image must be a data:image URL" }, 400);
    }

    if (body.image.length > 12_000_000) {
      return json({ error: "Image is too large. Crop or compress it first." }, 413);
    }

    const prompt = `You extract one credit-card, mobile-wallet, or payment receipt transaction from an image.
Return only valid JSON, no markdown.

Fields:
- date: ISO date YYYY-MM-DD. Empty string if not visible.
- amount: transaction amount as a number. Do not use order numbers, card numbers, points, delivery days, balances, discounts, or phone numbers.
- currency: RMB or HKD.
- merchant: merchant or counterparty name. Empty string if not visible.
- region: mainland, macau, hongkong, or overseas.
- category: dining, shopping, travel, or other.
- payment: applepay, unionpay, or other.
- confidence: number from 0 to 1.
- note: short reason if any field is uncertain.

Important:
- If the image is not a payment or credit-card transaction receipt, set amount to 0 and confidence below 0.2.
- Prefer labels near 实付, 支付金额, 交易金额, 消费金额, Amount, Total, Paid.
- Ignore ranges like 3-5 工作日 and identifiers like 订单号 or 卡号.`;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: body.image, detail: "high" },
            ],
          },
        ],
        max_output_tokens: 600,
      }),
    });

    const openaiJson = await openaiResponse.json().catch(() => null);
    if (!openaiResponse.ok) {
      return json(
        {
          error:
            openaiJson?.error?.message ||
            `OpenAI API error ${openaiResponse.status}`,
        },
        502,
      );
    }

    try {
      const receipt = normalizeReceipt(parseJsonObject(extractOutputText(openaiJson)));
      return json({ ok: true, result: receipt });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Could not parse AI response",
          raw: extractOutputText(openaiJson).slice(0, 1000),
        },
        502,
      );
    }
  },
};
