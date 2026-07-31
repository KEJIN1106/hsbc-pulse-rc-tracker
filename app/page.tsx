"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Region = "mainland" | "macau" | "hongkong" | "overseas";
type Category = "dining" | "shopping" | "travel" | "other";
type PaymentMethod = "applepay" | "unionpay" | "other";

type Transaction = {
  id: string;
  date: string;
  amount: number;
  currency: "HKD" | "RMB";
  region: Region;
  category: Category;
  payment: PaymentMethod;
  redHotEligible?: boolean;
  diningEligible?: boolean;
  note: string;
};

type Settings = {
  openDate: string;
};

type TransactionInput = Omit<Transaction, "id">;

type TesseractApi = {
  recognize: (
    image: File,
    languages: string,
    options?: {
      logger?: (progress: { status?: string; progress?: number }) => void;
    },
  ) => Promise<{ data: { text: string } }>;
};

type RecognizedReceipt = {
  date: string;
  amount: number;
  currency: "HKD" | "RMB";
  merchant: string;
  payment: PaymentMethod;
  region: Region;
  category: Category;
  diningEligible: boolean;
  confidence: number;
  note: string;
};

declare global {
  interface Window {
    Tesseract?: TesseractApi;
  }
}

const STORAGE_KEY = "hsbc-pulse-cashback-v1";
const AI_ENDPOINT_STORAGE_KEY = "hsbc-pulse-ai-endpoint-v1";
const BASE_RATE = 0.004;
const RED_HOT_EXTRA_RATE = 0.02;
const PULSE_EXTRA_RATE = 0.02;
const DINING_EXTRA_RATE = 0.03;
const DINING_PROMO_START = "2026-07-01";
const DINING_PROMO_END = "2026-12-31";
const DINING_PROMO_MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
const DINING_MONTHLY_THRESHOLD = 1200;
const DINING_MONTHLY_REWARD_CAP = 80;
const DINING_PROMO_REWARD_CAP = 480;
const DINING_MONTHLY_SPEND_FOR_CAP = DINING_MONTHLY_REWARD_CAP / DINING_EXTRA_RATE;
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
let tesseractLoader: Promise<TesseractApi> | null = null;

const DEFAULT_SETTINGS: Settings = {
  openDate: "",
};

const DEFAULT_INPUT: TransactionInput = {
  date: new Date().toISOString().slice(0, 10),
  amount: 128,
  currency: "RMB",
  region: "mainland",
  category: "dining",
  payment: "applepay",
  redHotEligible: true,
  diningEligible: true,
  note: "",
};

const regionLabels: Record<Region, string> = {
  mainland: "中国内地",
  macau: "澳门",
  hongkong: "香港",
  overseas: "其他地区",
};

const categoryLabels: Record<Category, string> = {
  dining: "餐饮",
  shopping: "购物",
  travel: "旅行",
  other: "其他",
};

const paymentLabels: Record<PaymentMethod, string> = {
  applepay: "Apple Pay",
  unionpay: "云闪付",
  other: "其他",
};

const quickAmounts = [50, 88, 120, 300, 800, 1200];

function datePlusDays(date: string, days: number) {
  if (!date) return "";
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function isWithinWelcomeWindow(date: string, openDate: string) {
  if (!openDate) return false;
  return date >= openDate && date <= datePlusDays(openDate, 59);
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function formatAmount(value: number) {
  return value.toLocaleString("zh-HK", {
    maximumFractionDigits: 2,
  });
}

function formatRc(value: number) {
  return value.toLocaleString("zh-HK", {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(value, max));
}

function progressPercent(value: number, max: number) {
  if (max <= 0) return 0;
  return clamp((value / max) * 100, 100);
}

function canUseRedHot(transaction: Transaction) {
  return (
    transaction.redHotEligible !== false &&
    (transaction.region === "mainland" || transaction.region === "macau")
  );
}

function canUsePulseExtra(transaction: Transaction) {
  return transaction.payment === "applepay" || transaction.payment === "unionpay";
}

function isDiningPromoMainland(transaction: Transaction) {
  return (
    transaction.region === "mainland" &&
    transaction.date >= DINING_PROMO_START &&
    transaction.date <= DINING_PROMO_END
  );
}

function isMainlandDining(transaction: Transaction) {
  return (
    transaction.diningEligible !== false &&
    isDiningPromoMainland(transaction) &&
    transaction.category === "dining"
  );
}

function allocateCappedRewards(
  transactions: Transaction[],
  predicate: (transaction: Transaction) => boolean,
  capAmount: number,
  rate: number,
) {
  let used = 0;
  let reward = 0;

  for (const transaction of transactions) {
    if (!predicate(transaction)) continue;
    const eligibleAmount = Math.min(transaction.amount, Math.max(capAmount - used, 0));
    reward += eligibleAmount * rate;
    used += eligibleAmount;
    if (used >= capAmount) break;
  }

  return {
    used,
    reward,
  };
}

function analyzeRewards(transactions: Transaction[], settings: Settings) {
  const sorted = [...transactions].sort((a, b) =>
    `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`),
  );

  const totalSpend = sorted.reduce((sum, transaction) => sum + transaction.amount, 0);
  const baseReward = totalSpend * BASE_RATE;
  const welcomeTransactions = sorted.filter((transaction) =>
    isWithinWelcomeWindow(transaction.date, settings.openDate),
  );
  const welcomeSpendByCurrency = {
    HKD: welcomeTransactions
      .filter((transaction) => transaction.currency === "HKD")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
    RMB: welcomeTransactions
      .filter((transaction) => transaction.currency === "RMB")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
  };
  const welcomeSpend = welcomeSpendByCurrency.HKD + welcomeSpendByCurrency.RMB;
  const welcomeReached = welcomeSpend >= 8000;
  const welcomeBonus = welcomeReached ? 1800 : 0;

  const redHot = allocateCappedRewards(
    sorted,
    canUseRedHot,
    100000,
    RED_HOT_EXTRA_RATE,
  );
  const pulse = allocateCappedRewards(sorted, canUsePulseExtra, 80000, PULSE_EXTRA_RATE);

  const months = new Map<
    string,
    {
      total: number;
      dining: number;
      reward: number;
    }
  >();

  for (const month of DINING_PROMO_MONTHS) {
    months.set(month, {
      total: 0,
      dining: 0,
      reward: 0,
    });
  }

  for (const transaction of sorted) {
    if (!isDiningPromoMainland(transaction)) continue;
    const key = monthKey(transaction.date);
    const current = months.get(key) ?? {
      total: 0,
      dining: 0,
      reward: 0,
    };
    current.total += transaction.amount;
    if (isMainlandDining(transaction)) current.dining += transaction.amount;
    months.set(key, current);
  }

  let diningTotalReward = 0;
  for (const current of months.values()) {
    current.reward =
      current.total >= DINING_MONTHLY_THRESHOLD
        ? Math.min(current.dining * DINING_EXTRA_RATE, DINING_MONTHLY_REWARD_CAP)
        : 0;
    diningTotalReward += current.reward;
  }

  diningTotalReward = Math.min(diningTotalReward, DINING_PROMO_REWARD_CAP);

  const bestPostureSpend = sorted
    .filter(
      (transaction) =>
        canUsePulseExtra(transaction) &&
        (transaction.region === "mainland" || transaction.region === "macau"),
    )
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  return {
    baseReward,
    welcomeSpend,
    welcomeSpendByCurrency,
    welcomeReached,
    welcomeBonus,
    redHotSpend: redHot.used,
    redHotReward: redHot.reward,
    pulseSpend: pulse.used,
    pulseReward: pulse.reward,
    diningMonths: DINING_PROMO_MONTHS.map((month) => [month, months.get(month)!] as const),
    diningReward: diningTotalReward,
    totalSpend,
    bestPostureSpend,
    totalReward:
      baseReward +
      welcomeBonus +
      redHot.reward +
      pulse.reward +
      diningTotalReward,
  };
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
}

function normalizeOcrText(text: string) {
  return text
    .replace(/[，]/g, ",")
    .replace(/[。．]/g, ".")
    .replace(/[￥]/g, "¥")
    .replace(/\u00a0/g, " ")
    .trim();
}

function toIsoDate(year: string | number, month: string, day: string) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return "";
  return `${yyyy}-${mm}-${dd}`;
}

function extractDateFromText(text: string) {
  const normalized = normalizeOcrText(text);
  const numeric = normalized.match(/\b(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?\b/);
  if (numeric) return toIsoDate(numeric[1], numeric[2], numeric[3]);

  const shortDate = normalized.match(/\b(\d{1,2})[-/.月](\d{1,2})日?\b/);
  if (shortDate) return toIsoDate(new Date().getFullYear(), shortDate[1], shortDate[2]);

  return "";
}

function extractAmountFromText(text: string) {
  const lines = normalizeOcrText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates: { value: number; priority: number; index: number }[] = [];

  lines.forEach((line, index) => {
    const hasMoneyKeyword =
      /(金额|实付|付款|支付|消费|合计|总计|交易|amount|total|paid|rmb|cny|hkd|¥|hk\$|\$)/i.test(
        line,
      );
    const isNoise = /(余额|积分|奖赏|reward|cashback|优惠|折扣|单号|订单|卡号)/i.test(line);
    const matches = line
      .replace(/,/g, "")
      .matchAll(/(?:HKD|RMB|CNY|HK\$|¥|\$)?\s*(-?\d+(?:\.\d{1,2})?)/gi);

    for (const match of matches) {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0 || value > 500000) continue;
      if (/^20\d{2}$/.test(match[1])) continue;
      const hasDecimal = match[1].includes(".");
      const priority = (hasMoneyKeyword ? 4 : 0) + (hasDecimal ? 2 : 0) - (isNoise ? 3 : 0);
      candidates.push({ value, priority, index });
    }
  });

  if (!candidates.length) return 0;
  candidates.sort((a, b) => b.priority - a.priority || b.value - a.value || a.index - b.index);
  return candidates[0].value;
}

function extractMerchantFromText(text: string) {
  const lines = normalizeOcrText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2);
  const skip =
    /(成功|付款|支付|金额|合计|总计|交易|订单|单号|时间|日期|卡号|银行|汇丰|HSBC|RMB|CNY|HKD|¥|\$|\d{4}[-/.年]\d{1,2})/i;
  return lines.find((line) => !skip.test(line) && /[\u4e00-\u9fa5A-Za-z]/.test(line)) || "";
}

function parseReceiptText(text: string) {
  const normalized = normalizeOcrText(text);
  const lower = normalized.toLowerCase();
  const merchant = extractMerchantFromText(normalized);
  const date = extractDateFromText(normalized);
  const amount = extractAmountFromText(normalized);
  const currency: "HKD" | "RMB" = /hkd|hk\$|港币/i.test(normalized) ? "HKD" : "RMB";
  const region: Region = /澳门|macau/i.test(normalized)
    ? "macau"
    : /香港|hong\s*kong/i.test(normalized)
      ? "hongkong"
      : "mainland";
  const payment: PaymentMethod = /apple\s*pay/i.test(normalized)
    ? "applepay"
    : /云闪付|银联|unionpay|union\s*pay/i.test(normalized)
      ? "unionpay"
      : "other";
  const category: Category =
    /(餐|饭|饮|咖啡|茶|火锅|酒|restaurant|cafe|food|kfc|mcdonald|starbucks|meituan|美团|海底捞|麦当劳|肯德基)/i.test(
      lower,
    )
      ? "dining"
      : "other";

  return { amount, currency, date, merchant, payment, region, category, diningEligible: category === "dining" };
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoader) return tesseractLoader;

  tesseractLoader = new Promise<TesseractApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_URL;
    script.async = true;
    script.onload = () =>
      window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR 加载失败"));
    script.onerror = () => reject(new Error("OCR 加载失败，请检查网络。"));
    document.head.appendChild(script);
  });

  return tesseractLoader;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.readAsDataURL(file);
  });
}

function categoryFromAiData(data: Record<string, unknown>) {
  const source = `${data.merchant || ""} ${data.note || ""}`.toLowerCase();
  if (/meituan|美团/.test(source)) return "dining";
  return ["dining", "shopping", "travel", "other"].includes(String(data.category))
    ? (data.category as Category)
    : "other";
}

function paymentFromAiData(data: Record<string, unknown>) {
  const source = `${data.payment || ""} ${data.merchant || ""} ${data.note || ""}`;
  if (/apple\s*pay/i.test(source)) return "applepay";
  if (/(^|[^a-z])qr([^a-z]|$)/i.test(source)) return "unionpay";
  return "other";
}

function normalizeAiReceiptItem(data: Record<string, unknown> | null | undefined) {
  if (!data) return null;
  const amount = Number(data?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const category = categoryFromAiData(data);

  return {
    date: typeof data.date === "string" ? data.date : "",
    amount,
    currency: data.currency === "HKD" ? "HKD" : ("RMB" as "HKD" | "RMB"),
    region: ["mainland", "macau", "hongkong", "overseas"].includes(String(data.region))
      ? (data.region as Region)
      : "mainland",
    category,
    diningEligible: category === "dining",
    payment: paymentFromAiData(data),
    merchant: typeof data.merchant === "string" ? data.merchant : "",
    confidence: Number(data.confidence || 0),
    note: typeof data.note === "string" ? data.note : "",
  } satisfies RecognizedReceipt;
}

function normalizeAiReceipts(raw: unknown) {
  const container = raw as {
    results?: unknown[];
    transactions?: unknown[];
    receipts?: unknown[];
    result?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
  };
  const list = Array.isArray(container?.results)
    ? container.results
    : Array.isArray(container?.transactions)
      ? container.transactions
      : Array.isArray(container?.receipts)
        ? container.receipts
        : [container?.result || container?.receipt || raw];

  return list
    .map((item) => normalizeAiReceiptItem(item as Record<string, unknown>))
    .filter((item): item is RecognizedReceipt => Boolean(item));
}

export default function Home() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [input, setInput] = useState<TransactionInput>(DEFAULT_INPUT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState("记录保存在本机浏览器。");
  const [scanStatus, setScanStatus] = useState(
    "AI 更准；本地 OCR 免费但容易误判。识别后请确认再保存。",
  );
  const [isScanning, setIsScanning] = useState(false);
  const [isAiScanning, setIsAiScanning] = useState(false);
  const [aiEndpoint, setAiEndpoint] = useState("");
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const aiReceiptInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        settings?: Settings;
        transactions?: Transaction[];
      };
      setSettings({ ...DEFAULT_SETTINGS, ...parsed.settings });
      setTransactions(parsed.transactions ?? []);
    } catch {
      setNotice("读取本地记录失败，可以继续新增记录。");
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ settings, transactions }),
    );
  }, [settings, transactions]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    setAiEndpoint(window.localStorage.getItem(AI_ENDPOINT_STORAGE_KEY) || "");
  }, []);

  const analysis = useMemo(
    () => analyzeRewards(transactions, settings),
    [transactions, settings],
  );

  const visibleTransactions = useMemo(() => {
    const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
    if (filter === "all") return sorted;
    if (filter === "welcome") {
      return sorted.filter((transaction) =>
        isWithinWelcomeWindow(transaction.date, settings.openDate),
      );
    }
    if (filter === "best") {
      return sorted.filter(
        (transaction) =>
          canUsePulseExtra(transaction) &&
          (transaction.region === "mainland" || transaction.region === "macau"),
      );
    }
    return sorted.filter((transaction) => transaction.category === filter);
  }, [filter, settings.openDate, transactions]);

  const currentMonth = monthKey(todayString());
  const currentDiningMonth = analysis.diningMonths.find(([key]) => key === currentMonth)?.[1] ?? {
    total: 0,
    dining: 0,
    reward: 0,
  };
  const welcomeDeadline = settings.openDate ? datePlusDays(settings.openDate, 59) : "";
  const daysLeft = welcomeDeadline ? daysBetween(todayString(), welcomeDeadline) : null;

  function updateInput<Value extends keyof TransactionInput>(
    key: Value,
    value: TransactionInput[Value],
  ) {
    setInput((current) => ({ ...current, [key]: value }));
  }

  function saveTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.date || input.amount <= 0) {
      setNotice("请输入有效日期和金额。");
      return;
    }

    if (editingId) {
      setTransactions((current) =>
        current.map((transaction) =>
          transaction.id === editingId ? { ...input, id: editingId } : transaction,
        ),
      );
      setEditingId(null);
      setNotice("这一笔已经更新。");
    } else {
      setTransactions((current) => [
        { ...input, id: crypto.randomUUID() },
        ...current,
      ]);
      setNotice("已记录，会自动重新计算返现。");
    }

    setInput((current) => ({ ...DEFAULT_INPUT, date: current.date }));
  }

  function editTransaction(transaction: Transaction) {
    const { id: _id, ...rest } = transaction;
    setInput(rest);
    setEditingId(transaction.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteTransaction(id: string) {
    setTransactions((current) => current.filter((transaction) => transaction.id !== id));
    if (editingId === id) setEditingId(null);
    setNotice("已删除这一笔记录。");
  }

  function exportData() {
    const payload = JSON.stringify({ settings, transactions }, null, 2);
    navigator.clipboard
      .writeText(payload)
      .then(() => setNotice("备份数据已复制到剪贴板。"))
      .catch(() => setNotice("复制失败，可在浏览器权限里允许剪贴板。"));
  }

  function prefillReceipt(
    parsed: {
      date: string;
      amount: number;
      currency: "HKD" | "RMB";
      merchant: string;
      payment: PaymentMethod;
      region: Region;
      category: Category;
      diningEligible?: boolean;
    },
    sourceLabel: string,
  ) {
    setInput((current) => ({
      ...current,
      date: parsed.date || current.date || todayString(),
      amount: parsed.amount,
      currency: parsed.currency,
      region: parsed.region,
      category: parsed.category,
      payment: parsed.payment,
      diningEligible:
        typeof parsed.diningEligible === "boolean" ? parsed.diningEligible : current.diningEligible,
      note: parsed.merchant ? `${sourceLabel}：${parsed.merchant}` : sourceLabel,
    }));
  }

  function transactionFromReceipt(
    parsed: {
      date: string;
      amount: number;
      currency: "HKD" | "RMB";
      merchant: string;
      payment: PaymentMethod;
      region: Region;
      category: Category;
      diningEligible?: boolean;
    },
    sourceLabel: string,
  ): Transaction {
    return {
      id: crypto.randomUUID(),
      date: parsed.date || input.date || todayString(),
      amount: parsed.amount,
      currency: parsed.currency,
      region: parsed.region,
      category: parsed.category,
      payment: parsed.payment,
      redHotEligible: input.redHotEligible,
      diningEligible:
        typeof parsed.diningEligible === "boolean" ? parsed.diningEligible : input.diningEligible,
      note: parsed.merchant ? `${sourceLabel}：${parsed.merchant}` : sourceLabel,
    };
  }

  async function scanReceiptImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsScanning(true);
    setScanStatus("正在加载 OCR...");
    setNotice("正在识别截图，请稍等。");

    try {
      const tesseract = await loadTesseract();
      const result = await tesseract.recognize(file, "eng+chi_sim", {
        logger: (progress) => {
          if (progress.status === "recognizing text") {
            setScanStatus(`正在识别文字 ${Math.round((progress.progress ?? 0) * 100)}%`);
          }
        },
      });
      const parsed = parseReceiptText(result.data.text || "");
      if (!parsed.amount) {
        setScanStatus("没有识别到金额，请换一张更清晰的截图。");
        setNotice("截图识别失败，可以继续手动录入。");
        return;
      }

      prefillReceipt(parsed, "本地OCR");
      setScanStatus(`已预填：${parsed.currency} ${formatAmount(parsed.amount)}，请确认后保存。`);
      setNotice("OCR 已预填表单，请检查日期、金额、类别和支付方式后再保存。");
    } catch (error) {
      setScanStatus(error instanceof Error ? error.message : "OCR 识别失败。");
      setNotice("截图识别失败，可以继续手动录入。");
    } finally {
      setIsScanning(false);
      event.target.value = "";
    }
  }

  async function scanReceiptWithAi(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const endpoint = aiEndpoint.trim();
    if (!endpoint) {
      setScanStatus("请先填写 Cloudflare Worker 的 AI 接口 URL。");
      setNotice("AI 识别需要后端代理 URL，API Key 不能放在网页里。");
      event.target.value = "";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setScanStatus("图片超过 8MB，请先裁剪或压缩。");
      event.target.value = "";
      return;
    }

    setIsAiScanning(true);
    setScanStatus("正在上传给 AI 识别...");
    setNotice("AI 只会预填表单，请确认后再保存。");

    try {
      window.localStorage.setItem(AI_ENDPOINT_STORAGE_KEY, endpoint);
      const image = await fileToDataUrl(file);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `AI 接口错误 ${response.status}`);
      }
      const parsedList = normalizeAiReceipts(payload);
      if (!parsedList.length) throw new Error("AI 没有返回有效金额。");

      if (parsedList.length === 1) {
        const parsed = parsedList[0];
        prefillReceipt(parsed, "AI识别");
        const confidence = parsed.confidence
          ? `，置信度 ${Math.round(parsed.confidence * 100)}%`
          : "";
        setScanStatus(`AI 已预填：${parsed.currency} ${formatAmount(parsed.amount)}${confidence}`);
        setNotice("AI 已预填表单，请检查日期、金额、类别和支付方式后再保存。");
        return;
      }

      const total = parsedList.reduce((sum, item) => sum + item.amount, 0);
      const accepted = window.confirm(
        `AI 识别到 ${parsedList.length} 条交易，合计 ${formatAmount(total)}。是否全部加入记录？`,
      );
      if (!accepted) {
        prefillReceipt(parsedList[0], "AI识别");
        setScanStatus(`已先预填第 1 条，共 ${parsedList.length} 条。`);
        setNotice("你取消了批量加入；已把第一条预填到表单。");
        return;
      }

      setTransactions((current) => [
        ...parsedList.map((item) => transactionFromReceipt(item, "AI识别")),
        ...current,
      ]);
      setScanStatus(`已加入 ${parsedList.length} 条 AI 识别记录，合计 ${formatAmount(total)}。`);
      setNotice("批量加入完成，请在记录列表检查每一笔。");
    } catch (error) {
      setScanStatus(error instanceof Error ? error.message : "AI 识别失败。");
      setNotice("AI 识别失败，可以改用本地 OCR 或手动录入。");
    } finally {
      setIsAiScanning(false);
      event.target.value = "";
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f3ec] text-[#161616]">
      <section className="app-shell">
        <div className="hero">
          <div>
            <p className="eyebrow">HSBC Pulse RC Tracker</p>
            <h1>汇丰 Pulse 返现记录</h1>
            <p className="hero-copy">
              记录每一笔 Apple Pay、云闪付、内地餐饮和迎新消费，自动盯住
              8,000、80,000、100,000 与每月餐饮上限。
            </p>
          </div>
          <div className="total-panel" aria-label="预计奖赏钱">
            <span>预计奖赏钱</span>
            <strong>{formatRc(analysis.totalReward)} RC</strong>
            <small>已记录消费 {formatAmount(analysis.totalSpend)}</small>
          </div>
        </div>

        <section className="settings-strip" aria-label="卡片设置">
          <label className="date-field">
            <span>开卡日期</span>
            <input
              type="date"
              value={settings.openDate}
              onChange={(event) =>
                setSettings((current) => ({ ...current, openDate: event.target.value }))
              }
            />
          </label>
        </section>

        <section className="grid-two">
          <form className="entry-panel" onSubmit={saveTransaction}>
            <div className="panel-title">
              <div>
                <p className="eyebrow">Add Spend</p>
                <h2>{editingId ? "编辑消费" : "新增消费"}</h2>
              </div>
              {editingId ? (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setInput(DEFAULT_INPUT);
                  }}
                >
                  取消
                </button>
              ) : null}
            </div>

            <div className="field-grid">
              <label className="date-field">
                <span>日期</span>
                <input
                  type="date"
                  value={input.date}
                  onChange={(event) => updateInput("date", event.target.value)}
                />
              </label>
              <label>
                <span>金额</span>
                <input
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  type="number"
                  value={input.amount}
                  onChange={(event) =>
                    updateInput("amount", Number(event.target.value))
                  }
                />
              </label>
              <label>
                <span>币种</span>
                <select
                  value={input.currency}
                  onChange={(event) =>
                    updateInput("currency", event.target.value as "HKD" | "RMB")
                  }
                >
                  <option value="RMB">人民币</option>
                  <option value="HKD">港币</option>
                </select>
              </label>
              <label>
                <span>地区</span>
                <select
                  value={input.region}
                  onChange={(event) => updateInput("region", event.target.value as Region)}
                >
                  {Object.entries(regionLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>类别</span>
                <select
                  value={input.category}
                  onChange={(event) =>
                    updateInput("category", event.target.value as Category)
                  }
                >
                  {Object.entries(categoryLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>支付</span>
                <select
                  value={input.payment}
                  onChange={(event) =>
                    updateInput("payment", event.target.value as PaymentMethod)
                  }
                >
                  {Object.entries(paymentLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="reward-options" aria-label="逐笔返现选项">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={input.redHotEligible !== false}
                  onChange={(event) =>
                    updateInput("redHotEligible", event.target.checked)
                  }
                />
                <span>这一笔计算赏世界额外 2%</span>
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={input.diningEligible !== false}
                  onChange={(event) =>
                    updateInput("diningEligible", event.target.checked)
                  }
                />
                <span>这一笔参与内地餐饮额外 3%</span>
              </label>
            </div>

            <div className="scan-box">
              <input
                ref={receiptInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                onChange={scanReceiptImage}
              />
              <input
                ref={aiReceiptInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                onChange={scanReceiptWithAi}
              />
              <label className="scan-endpoint">
                <span>AI 接口 URL</span>
                <input
                  placeholder="https://你的-worker.workers.dev/receipt"
                  type="url"
                  value={aiEndpoint}
                  onChange={(event) => {
                    setAiEndpoint(event.target.value);
                    window.localStorage.setItem(AI_ENDPOINT_STORAGE_KEY, event.target.value.trim());
                  }}
                />
              </label>
              <div className="scan-actions">
                <button
                  className="ghost-button"
                  type="button"
                  disabled={isAiScanning}
                  onClick={() => aiReceiptInputRef.current?.click()}
                >
                  {isAiScanning ? "AI 识别中..." : "AI 识别截图"}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={isScanning}
                  onClick={() => receiptInputRef.current?.click()}
                >
                  {isScanning ? "识别中..." : "本地 OCR"}
                </button>
              </div>
              <span>{scanStatus}</span>
            </div>

            <div className="quick-row" aria-label="快速金额">
              {quickAmounts.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => updateInput("amount", amount)}
                >
                  {amount}
                </button>
              ))}
            </div>

            <label>
              <span>备注</span>
              <input
                placeholder="商户、订单或账单说明"
                value={input.note}
                onChange={(event) => updateInput("note", event.target.value)}
              />
            </label>

            <button className="primary-button" type="submit">
              {editingId ? "保存修改" : "记录这一笔"}
            </button>
            <p className="notice">{notice}</p>
          </form>

          <section className="insight-panel" aria-label="关键提醒">
            <div className="panel-title">
              <div>
                <p className="eyebrow">Checklist</p>
                <h2>别漏掉这些</h2>
              </div>
              <button className="ghost-button" type="button" onClick={exportData}>
                备份
              </button>
            </div>

            <div className="task-list">
              <div className={settings.openDate ? "task done" : "task urgent"}>
                <strong>{settings.openDate ? "已设置开卡日期" : "先填开卡日期"}</strong>
                <span>
                  {settings.openDate
                    ? `迎新窗口到 ${welcomeDeadline}`
                    : "用于判断开卡后 60 天。"}
                </span>
              </div>
              <div
                className={
                  currentDiningMonth.total >= DINING_MONTHLY_THRESHOLD ? "task done" : "task"
                }
              >
                <strong>本月内地餐饮门槛</strong>
                <span>
                  {currentDiningMonth.total >= DINING_MONTHLY_THRESHOLD
                    ? `总签账 ${formatAmount(currentDiningMonth.total)} 已达门槛，餐饮 ${formatAmount(
                        currentDiningMonth.dining,
                      )}，已估 ${formatRc(currentDiningMonth.reward)} RC。`
                    : `本月总签账 ${formatAmount(currentDiningMonth.total)}，还差 ${formatAmount(
                        Math.max(DINING_MONTHLY_THRESHOLD - currentDiningMonth.total, 0),
                      )} 解锁；达标后当月餐饮从第一元算 3%。`}
                </span>
              </div>
              <div className={analysis.pulseSpend < 80000 ? "task" : "task done"}>
                <strong>最佳支付姿势</strong>
                <span>
                  Apple Pay/云闪付优先刷到 80,000，之后到 100,000 仍保留赏世界。
                </span>
              </div>
            </div>
          </section>
        </section>

        <section className="progress-grid" aria-label="返现进度">
          <ProgressCard
            label="迎新 8,000 HKD/RMB"
            value={analysis.welcomeSpend}
            max={8000}
            detail={
              analysis.welcomeReached
                ? `已达标，HKD ${formatAmount(analysis.welcomeSpendByCurrency.HKD)} + RMB ${formatAmount(
                    analysis.welcomeSpendByCurrency.RMB,
                  )}`
                : `HKD ${formatAmount(analysis.welcomeSpendByCurrency.HKD)} + RMB ${formatAmount(
                    analysis.welcomeSpendByCurrency.RMB,
                  )}；还差 ${formatAmount(Math.max(8000 - analysis.welcomeSpend, 0))}`
            }
            tone="green"
          />
          <ProgressCard
            label="内地餐饮额外 3%"
            value={analysis.diningReward}
            max={DINING_PROMO_REWARD_CAP}
            detail="六个月合计；月满 1,200 后当月餐饮从第一元计 3%，月封顶 80"
            tone="amber"
          />
          <ProgressCard
            label="Pulse 额外 2%"
            value={analysis.pulseSpend}
            max={80000}
            detail={`已估 ${formatRc(analysis.pulseReward)} RC`}
            tone="red"
          />
          <ProgressCard
            label="赏世界额外 2%"
            value={analysis.redHotSpend}
            max={100000}
            detail={`已估 ${formatRc(analysis.redHotReward)} RC`}
            tone="blue"
          />
        </section>

        <section className="summary-band">
          <Metric label="基础 0.4%" value={`${formatRc(analysis.baseReward)} RC`} />
          <Metric
            label="迎新奖励"
            value={`${formatRc(analysis.welcomeBonus)} RC`}
          />
          <Metric label="内地餐饮额外 3%" value={`${formatRc(analysis.diningReward)} RC`} />
          <Metric label="最佳姿势消费" value={formatAmount(analysis.bestPostureSpend)} />
        </section>

        <section className="records-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Records</p>
              <h2>消费记录</h2>
            </div>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">全部</option>
              <option value="welcome">迎新窗口</option>
              <option value="best">最佳支付姿势</option>
              <option value="dining">餐饮</option>
            </select>
          </div>

          {visibleTransactions.length === 0 ? (
            <div className="empty-state">
              <strong>还没有记录</strong>
              <span>先新增一笔消费，进度条会马上开始工作。</span>
            </div>
          ) : (
            <div className="record-list">
              {visibleTransactions.map((transaction) => (
                <article className="record" key={transaction.id}>
                  <div>
                    <strong>
                      {transaction.currency} {formatAmount(transaction.amount)}
                    </strong>
                    <span>
                      {transaction.date} · {regionLabels[transaction.region]} ·{" "}
                      {categoryLabels[transaction.category]}
                    </span>
                    <small>
                      {paymentLabels[transaction.payment]}
                      {transaction.note ? ` · ${transaction.note}` : ""}
                    </small>
                  </div>
                  <div className="record-actions">
                    <button type="button" onClick={() => editTransaction(transaction)}>
                      编辑
                    </button>
                    <button type="button" onClick={() => deleteTransaction(transaction.id)}>
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="month-panel">
          <div className="panel-title">
            <div>
              <p className="eyebrow">Dining</p>
              <h2>六个月餐饮奖励</h2>
            </div>
            <span className="cap-badge">2026-07 至 12：月满1,200，餐饮3%，月80/总480</span>
          </div>
          <div className="month-grid">
            {analysis.diningMonths.map(([key, month]) => (
              <div className="month-card" key={key}>
                <strong>{key}</strong>
                <span>
                  总签账 {formatAmount(month.total)}
                  {month.total >= DINING_MONTHLY_THRESHOLD
                    ? "，已达门槛"
                    : `，差 ${formatAmount(DINING_MONTHLY_THRESHOLD - month.total)}`}
                </span>
                <span>
                  餐饮 {formatAmount(month.dining)} / {formatAmount(DINING_MONTHLY_SPEND_FOR_CAP)} 封顶
                </span>
                <b>{formatRc(month.reward)} RC</b>
              </div>
            ))}
          </div>
        </section>

        <footer>
          计算按你提供的规则：HKD/RMB 按 1:1 记录；最终入账以汇丰账单和活动条款为准。
          {daysLeft !== null && daysLeft >= 0 ? ` 迎新还剩 ${daysLeft + 1} 天。` : ""}
        </footer>
      </section>
    </main>
  );
}

function ProgressCard({
  label,
  value,
  max,
  detail,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  detail: string;
  tone: "green" | "amber" | "red" | "blue";
}) {
  return (
    <article className={`progress-card ${tone}`}>
      <div>
        <span>{label}</span>
        <strong>
          {formatAmount(value)} / {formatAmount(max)}
        </strong>
      </div>
      <div className="progress-track" aria-hidden="true">
        <span style={{ width: `${progressPercent(value, max)}%` }} />
      </div>
      <small>{detail}</small>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
