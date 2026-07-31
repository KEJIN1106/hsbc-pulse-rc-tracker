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
    if (typeof item.content === "string") chunks.push(item.content);
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(
          typeof content.text === "string" ? content.text : JSON.stringify(content.text),
        );
      } else if (typeof content.text === "string") {
        chunks.push(content.text);
      } else if (content.text?.value) {
        chunks.push(content.text.value);
      } else if (content.json) {
        chunks.push(JSON.stringify(content.json));
      }
    }
  }
  return chunks.join("\n");
}

function firstJsonValue(text) {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return "";
  const start = Math.min(...starts);
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  const open = text[start];
  const close = open === "{" ? "}" : "]";

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return "";
}

function parseJsonObject(text) {
  if (!text.trim()) throw new Error("AI response was empty");
  try {
    return JSON.parse(text);
  } catch {
    const jsonText = firstJsonValue(text);
    if (!jsonText) throw new Error("AI did not return JSON");
    return JSON.parse(jsonText);
  }
}

function summarizeOpenAiResponse(response) {
  if (!response) return null;
  return {
    status: response.status,
    incomplete_details: response.incomplete_details,
    output: (response.output || []).map((item) => ({
      type: item.type,
      role: item.role,
      status: item.status,
      content_types: Array.isArray(item.content)
        ? item.content.map((content) => content.type || typeof content)
        : typeof item.content,
    })),
  };
}

function receiptCategory(receipt) {
  const source = `${receipt.merchant || ""} ${receipt.note || ""}`.toLowerCase();
  if (/meituan|美团/.test(source)) return "dining";
  return ["dining", "shopping", "travel", "other"].includes(receipt.category)
    ? receipt.category
    : "other";
}

function receiptPayment(receipt) {
  const source = `${receipt.payment || ""} ${receipt.merchant || ""} ${receipt.note || ""}`;
  if (/apple\s*pay/i.test(source)) return "applepay";
  if (/(^|[^a-z])qr([^a-z]|$)/i.test(source)) return "unionpay";
  return "other";
}

function normalizeReceipt(receipt) {
  const amount = Number(receipt.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("No valid amount found");
  }
  const category = receiptCategory(receipt);

  return {
    date: typeof receipt.date === "string" ? receipt.date : "",
    amount,
    currency: receipt.currency === "HKD" ? "HKD" : "RMB",
    merchant: typeof receipt.merchant === "string" ? receipt.merchant : "",
    region: ["mainland", "macau", "hongkong", "overseas"].includes(receipt.region)
      ? receipt.region
      : "mainland",
    category,
    diningEligible: category === "dining",
    payment: receiptPayment(receipt),
    confidence: Math.max(0, Math.min(Number(receipt.confidence || 0), 1)),
    note: typeof receipt.note === "string" ? receipt.note : "",
  };
}

function normalizeReceipts(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.transactions)
      ? payload.transactions
      : Array.isArray(payload.receipts)
        ? payload.receipts
        : Array.isArray(payload.results)
          ? payload.results
          : [payload];

  return source
    .map((receipt) => {
      try {
        return normalizeReceipt(receipt);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

    const prompt = `You extract all credit-card, mobile-wallet, or payment receipt transactions from an image.
Return only valid JSON, no markdown.

Return exactly this shape:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "amount": 0,
      "currency": "RMB",
      "merchant": "",
      "region": "mainland",
      "category": "other",
      "diningEligible": false,
      "payment": "other",
      "confidence": 0,
      "note": ""
    }
  ]
}

Fields for each transaction:
- date: ISO date YYYY-MM-DD. Empty string if not visible.
- amount: transaction amount as a number. Do not use order numbers, card numbers, points, delivery days, balances, discounts, or phone numbers.
- currency: RMB or HKD.
- merchant: merchant or counterparty name. Empty string if not visible.
- region: mainland, macau, hongkong, or overseas.
- category: dining, shopping, travel, or other.
- diningEligible: true when the transaction is an eligible dining transaction in Mainland China; false for non-dining or uncertain category.
- payment: applepay only if the receipt explicitly shows APPLEPAY or Apple Pay; unionpay only if it explicitly shows QR; otherwise other.
- confidence: number from 0 to 1.
- note: short reason if any field is uncertain.

Important:
- If the image contains multiple transaction rows, return every real transaction in transactions.
- If the image is not a payment or credit-card transaction receipt, return {"transactions":[]}.
- MEITUAN or 美团 merchants are dining.
- Dining category means restaurants, cafes, drinks, food delivery, and other dining receipts; it is not limited to MEITUAN.
- Classify category from merchant, item names, and receipt context: dining for restaurants, cafes, drinks, food delivery, and Meituan; shopping for retail, grocery, ecommerce, and supermarkets; travel for flights, hotels, trains, taxis, fuel, and transit; other if uncertain.
- Do not infer payment method from card scheme, bank name, UnionPay logo, or merchant name. For payment, only APPLEPAY/Apple Pay maps to applepay, only QR maps to unionpay, and everything else maps to other.
- Preserve recognizable platform words such as MEITUAN or 美团 in merchant or note.
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
        text: { format: { type: "json_object" } },
        max_output_tokens: 1600,
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
      const receipts = normalizeReceipts(parseJsonObject(extractOutputText(openaiJson)));
      if (!receipts.length) throw new Error("No valid amount found");
      return json({ ok: true, result: receipts[0], results: receipts });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Could not parse AI response",
          raw: extractOutputText(openaiJson).slice(0, 1000),
          response: summarizeOpenAiResponse(openaiJson),
        },
        502,
      );
    }
  },
};
