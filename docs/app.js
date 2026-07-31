const STORAGE_KEY = "hsbc-pulse-cashback-v1";
const BASE_RATE = 0.004;
const RED_HOT_EXTRA_RATE = 0.02;
const PULSE_EXTRA_RATE = 0.02;
const DINING_EXTRA_RATE = 0.03;

const regionLabels = {
  mainland: "中国内地",
  macau: "澳门",
  hongkong: "香港",
  overseas: "其他地区",
};

const categoryLabels = {
  dining: "餐饮",
  shopping: "购物",
  travel: "旅行",
  other: "其他",
};

const paymentLabels = {
  applepay: "Apple Pay",
  unionpay: "云闪付",
  other: "其他",
};

const state = {
  settings: {
    openDate: "",
  },
  transactions: [],
  editingId: null,
  filter: "all",
};

const ids = [
  "openDate",
  "date",
  "amount",
  "currency",
  "region",
  "category",
  "payment",
  "redHotEligible",
  "transactionDiningEligible",
  "note",
  "entryForm",
  "formTitle",
  "cancelEdit",
  "submitButton",
  "notice",
  "backupButton",
  "taskList",
  "progressGrid",
  "filter",
  "recordList",
  "monthGrid",
  "totalReward",
  "totalSpend",
  "baseReward",
  "welcomeReward",
  "diningReward",
  "bestPostureSpend",
  "footerNote",
];

const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function save() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      settings: state.settings,
      transactions: state.transactions,
    }),
  );
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.settings = { ...state.settings, ...(parsed.settings || {}) };
    state.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  } catch {
    setNotice("读取本地记录失败，可以继续新增记录。");
  }
}

function datePlusDays(date, days) {
  if (!date) return "";
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function isWithinWelcomeWindow(date, openDate) {
  if (!openDate) return false;
  return date >= openDate && date <= datePlusDays(openDate, 59);
}

function monthKey(date) {
  return date.slice(0, 7);
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString("zh-HK", { maximumFractionDigits: 0 });
}

function formatRc(value) {
  const number = Number(value || 0);
  return number.toLocaleString("zh-HK", {
    maximumFractionDigits: 2,
    minimumFractionDigits: number % 1 === 0 ? 0 : 2,
  });
}

function clamp(value, max) {
  return Math.max(0, Math.min(value, max));
}

function progressPercent(value, max) {
  if (max <= 0) return 0;
  return clamp((value / max) * 100, 100);
}

function canUseRedHot(transaction) {
  return (
    transaction.redHotEligible !== false &&
    (transaction.region === "mainland" || transaction.region === "macau")
  );
}

function canUsePulseExtra(transaction) {
  return transaction.payment === "applepay" || transaction.payment === "unionpay";
}

function isMainlandDining(transaction) {
  return (
    transaction.diningEligible !== false &&
    transaction.region === "mainland" &&
    transaction.category === "dining"
  );
}

function allocateCappedRewards(transactions, predicate, capAmount, rate) {
  let used = 0;
  let reward = 0;
  for (const transaction of transactions) {
    if (!predicate(transaction)) continue;
    const eligibleAmount = Math.min(transaction.amount, Math.max(capAmount - used, 0));
    reward += eligibleAmount * rate;
    used += eligibleAmount;
    if (used >= capAmount) break;
  }
  return { used, reward };
}

function analyzeRewards() {
  const sorted = [...state.transactions].sort((a, b) =>
    `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`),
  );
  const totalSpend = sorted.reduce((sum, transaction) => sum + transaction.amount, 0);
  const baseReward = totalSpend * BASE_RATE;
  const welcomeSpend = sorted
    .filter((transaction) => isWithinWelcomeWindow(transaction.date, state.settings.openDate))
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const welcomeReached = welcomeSpend >= 8000;
  const welcomeBonus = welcomeReached ? 1800 : 0;
  const redHot = allocateCappedRewards(sorted, canUseRedHot, 100000, RED_HOT_EXTRA_RATE);
  const pulse = allocateCappedRewards(sorted, canUsePulseExtra, 80000, PULSE_EXTRA_RATE);
  const months = new Map();

  for (const transaction of sorted) {
    const key = monthKey(transaction.date);
    const current = months.get(key) || { total: 0, dining: 0, reward: 0 };
    current.total += transaction.amount;
    if (isMainlandDining(transaction)) current.dining += transaction.amount;
    months.set(key, current);
  }

  let diningTotalReward = 0;
  for (const current of months.values()) {
    current.reward = current.total >= 1200 ? Math.min(current.dining * DINING_EXTRA_RATE, 80) : 0;
    diningTotalReward += current.reward;
  }
  diningTotalReward = Math.min(diningTotalReward, 480);

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
    welcomeReached,
    welcomeBonus,
    redHotSpend: redHot.used,
    redHotReward: redHot.reward,
    pulseSpend: pulse.used,
    pulseReward: pulse.reward,
    diningMonths: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    diningReward: diningTotalReward,
    totalSpend,
    bestPostureSpend,
    totalReward:
      baseReward + welcomeBonus + redHot.reward + pulse.reward + diningTotalReward,
  };
}

function daysBetween(start, end) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
}

function setNotice(message) {
  el.notice.textContent = message;
}

function currentInput() {
  return {
    date: el.date.value,
    amount: Number(el.amount.value),
    currency: el.currency.value,
    region: el.region.value,
    category: el.category.value,
    payment: el.payment.value,
    redHotEligible: el.redHotEligible.checked,
    diningEligible: el.transactionDiningEligible.checked,
    note: el.note.value.trim(),
  };
}

function setInput(transaction) {
  el.date.value = transaction.date;
  el.amount.value = transaction.amount;
  el.currency.value = transaction.currency;
  el.region.value = transaction.region;
  el.category.value = transaction.category;
  el.payment.value = transaction.payment;
  el.redHotEligible.checked = transaction.redHotEligible !== false;
  el.transactionDiningEligible.checked = transaction.diningEligible !== false;
  el.note.value = transaction.note || "";
}

function resetInput(keepDate = true) {
  const date = keepDate ? el.date.value : todayString();
  setInput({
    date,
    amount: 128,
    currency: "RMB",
    region: "mainland",
    category: "dining",
    payment: "applepay",
    redHotEligible: true,
    diningEligible: true,
    note: "",
  });
}

function renderTask(className, title, text) {
  return `<div class="task ${className}"><strong>${title}</strong><span>${text}</span></div>`;
}

function renderProgressCard(label, value, max, detail, tone) {
  return `
    <article class="progress-card ${tone}">
      <div>
        <span>${label}</span>
        <strong>${formatAmount(value)} / ${formatAmount(max)}</strong>
      </div>
      <div class="progress-track" aria-hidden="true">
        <span style="width: ${progressPercent(value, max)}%"></span>
      </div>
      <small>${detail}</small>
    </article>
  `;
}

function renderEmpty(title, text) {
  return `<div class="empty-state"><strong>${title}</strong><span>${text}</span></div>`;
}

function render() {
  el.openDate.value = state.settings.openDate;
  el.filter.value = state.filter;
  el.formTitle.textContent = state.editingId ? "编辑消费" : "新增消费";
  el.submitButton.textContent = state.editingId ? "保存修改" : "记录这一笔";
  el.cancelEdit.classList.toggle("hidden", !state.editingId);

  const analysis = analyzeRewards();
  const currentMonth = monthKey(todayString());
  const currentDiningMonth =
    analysis.diningMonths.find(([key]) => key === currentMonth)?.[1] || {
      total: 0,
      dining: 0,
      reward: 0,
    };
  const welcomeDeadline = state.settings.openDate ? datePlusDays(state.settings.openDate, 59) : "";
  const daysLeft = welcomeDeadline ? daysBetween(todayString(), welcomeDeadline) : null;

  el.totalReward.textContent = `${formatRc(analysis.totalReward)} RC`;
  el.totalSpend.textContent = `已记录消费 ${formatAmount(analysis.totalSpend)}`;
  el.baseReward.textContent = `${formatRc(analysis.baseReward)} RC`;
  el.welcomeReward.textContent = `${formatRc(analysis.welcomeBonus)} RC`;
  el.diningReward.textContent = `${formatRc(analysis.diningReward)} RC`;
  el.bestPostureSpend.textContent = formatAmount(analysis.bestPostureSpend);

  el.taskList.innerHTML = [
    renderTask(
      state.settings.openDate ? "done" : "urgent",
      state.settings.openDate ? "已设置开卡日期" : "先填开卡日期",
      state.settings.openDate ? `迎新窗口到 ${welcomeDeadline}` : "用于判断开卡后 60 天。",
    ),
    renderTask(
      currentDiningMonth.total >= 1200 ? "done" : "",
      "本月内地餐饮门槛",
      `本月总签账 ${formatAmount(currentDiningMonth.total)}，还差 ${formatAmount(
        Math.max(1200 - currentDiningMonth.total, 0),
      )} 解锁。`,
    ),
    renderTask(
      analysis.pulseSpend < 80000 ? "" : "done",
      "最佳支付姿势",
      "Apple Pay/云闪付优先刷到 80,000，之后到 100,000 仍保留赏世界。",
    ),
  ].join("");

  el.progressGrid.innerHTML = [
    renderProgressCard(
      "迎新 8,000",
      analysis.welcomeSpend,
      8000,
      analysis.welcomeReached
        ? "已达标，预计 1,800 RC"
        : `还差 ${formatAmount(Math.max(8000 - analysis.welcomeSpend, 0))}`,
      "green",
    ),
    renderProgressCard(
      "内地餐饮额外 3%",
      analysis.diningReward,
      480,
      "月满 1,200 后计算，月封顶 80 RC",
      "amber",
    ),
    renderProgressCard(
      "Pulse 额外 2%",
      analysis.pulseSpend,
      80000,
      `已估 ${formatRc(analysis.pulseReward)} RC`,
      "red",
    ),
    renderProgressCard(
      "赏世界额外 2%",
      analysis.redHotSpend,
      100000,
      `已估 ${formatRc(analysis.redHotReward)} RC`,
      "blue",
    ),
  ].join("");

  let visibleTransactions = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date));
  if (state.filter === "welcome") {
    visibleTransactions = visibleTransactions.filter((transaction) =>
      isWithinWelcomeWindow(transaction.date, state.settings.openDate),
    );
  } else if (state.filter === "best") {
    visibleTransactions = visibleTransactions.filter(
      (transaction) =>
        canUsePulseExtra(transaction) &&
        (transaction.region === "mainland" || transaction.region === "macau"),
    );
  } else if (state.filter !== "all") {
    visibleTransactions = visibleTransactions.filter(
      (transaction) => transaction.category === state.filter,
    );
  }

  el.recordList.innerHTML = visibleTransactions.length
    ? `<div class="record-list">${visibleTransactions
        .map(
          (transaction) => `
        <article class="record">
          <div>
            <strong>${transaction.currency} ${formatAmount(transaction.amount)}</strong>
            <span>${transaction.date} · ${regionLabels[transaction.region]} · ${
              categoryLabels[transaction.category]
            }</span>
            <small>${paymentLabels[transaction.payment]}${
              transaction.note ? ` · ${escapeHtml(transaction.note)}` : ""
            }</small>
          </div>
          <div class="record-actions">
            <button type="button" data-edit="${transaction.id}">编辑</button>
            <button type="button" data-delete="${transaction.id}">删除</button>
          </div>
        </article>
      `,
        )
        .join("")}</div>`
    : renderEmpty("还没有记录", "先新增一笔消费，进度条会马上开始工作。");

  el.monthGrid.innerHTML = analysis.diningMonths.length
    ? analysis.diningMonths
        .map(
          ([key, month]) => `
      <div class="month-card">
        <strong>${key}</strong>
        <span>总签账 ${formatAmount(month.total)}</span>
        <span>餐饮 ${formatAmount(month.dining)}</span>
        <b>${formatRc(month.reward)} RC</b>
      </div>
    `,
        )
        .join("")
    : renderEmpty("暂无月份", "内地餐饮消费会在这里按月汇总。");

  el.footerNote.textContent = `计算按你提供的规则：HKD/RMB 按 1:1 记录；最终入账以汇丰账单和活动条款为准。${
    daysLeft !== null && daysLeft >= 0 ? ` 迎新还剩 ${daysLeft + 1} 天。` : ""
  }`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function bindEvents() {
  el.openDate.addEventListener("change", () => {
    state.settings.openDate = el.openDate.value;
    save();
    render();
  });

  document.querySelectorAll("[data-amount]").forEach((button) => {
    button.addEventListener("click", () => {
      el.amount.value = button.dataset.amount;
    });
  });

  el.entryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const transaction = currentInput();
    if (!transaction.date || transaction.amount <= 0) {
      setNotice("请输入有效日期和金额。");
      return;
    }

    if (state.editingId) {
      state.transactions = state.transactions.map((item) =>
        item.id === state.editingId ? { ...transaction, id: state.editingId } : item,
      );
      state.editingId = null;
      setNotice("这一笔已经更新。");
    } else {
      state.transactions = [{ ...transaction, id: makeId() }, ...state.transactions];
      setNotice("已记录，会自动重新计算返现。");
    }

    save();
    resetInput(true);
    render();
  });

  el.cancelEdit.addEventListener("click", () => {
    state.editingId = null;
    resetInput(false);
    render();
  });

  el.filter.addEventListener("change", () => {
    state.filter = el.filter.value;
    render();
  });

  el.recordList.addEventListener("click", (event) => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.delete;
    if (editId) {
      const transaction = state.transactions.find((item) => item.id === editId);
      if (!transaction) return;
      state.editingId = editId;
      setInput(transaction);
      window.scrollTo({ top: 0, behavior: "smooth" });
      render();
    }
    if (deleteId) {
      state.transactions = state.transactions.filter((item) => item.id !== deleteId);
      if (state.editingId === deleteId) state.editingId = null;
      save();
      setNotice("已删除这一笔记录。");
      render();
    }
  });

  el.backupButton.addEventListener("click", () => {
    const payload = JSON.stringify(
      { settings: state.settings, transactions: state.transactions },
      null,
      2,
    );
    navigator.clipboard
      .writeText(payload)
      .then(() => setNotice("备份数据已复制到剪贴板。"))
      .catch(() => setNotice("复制失败，可在浏览器权限里允许剪贴板。"));
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}

load();
resetInput(false);
bindEvents();
render();
registerServiceWorker();
