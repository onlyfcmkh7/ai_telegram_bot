const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "18:57"];
const MAX_ATTEMPTS_PER_SLOT = 5;
const NEWS_PAGE_SIZE = 15;
const STATE_FILE = path.join(__dirname, "bot_state.json");

let lastUpdateId = 0;
let currentSlot = null;

const state = loadState();

/* ================= STATE ================= */

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { seenUrls: [], processedSlots: [], draftCounter: 0 };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { seenUrls: [], processedSlots: [], draftCounter: 0 };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function isSeen(url) {
  return state.seenUrls.includes(normalizeUrl(url));
}

function markSeen(url) {
  const u = normalizeUrl(url);
  if (!state.seenUrls.includes(u)) {
    state.seenUrls.push(u);
    saveState();
  }
}

function nextDraftId() {
  state.draftCounter++;
  saveState();
  return String(state.draftCounter);
}

/* ================= REQUEST ================= */

const sendRequest = (host, path, data = null, method = "GET") =>
  new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;

    const req = https.request(
      {
        hostname: host,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body ? Buffer.byteLength(body) : 0,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const tg = (path, data, method = "GET") =>
  sendRequest("api.telegram.org", `/bot${TOKEN}${path}`, data, method);

/* ================= TELEGRAM ================= */

const sendMessage = async (chatId, text, buttons = null) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (buttons) {
    payload.reply_markup = { inline_keyboard: [buttons] };
  }

  return tg("/sendMessage", payload, "POST");
};

const answer = (id, text) =>
  tg("/answerCallbackQuery", { callback_query_id: id, text }, "POST");

/* ================= NEWS ================= */

const getNews = async () => {
  const res = await sendRequest(
    "newsapi.org",
    `/v2/everything?q=crypto&language=en&sortBy=publishedAt&pageSize=${NEWS_PAGE_SIZE}&apiKey=${NEWS_API_KEY}`
  );

  return res.articles.map((a) => ({
    title: a.title,
    description: a.description,
    url: a.url,
  }));
};

const translate = async (text) => {
  const res = await sendRequest(
    "api.mymemory.translated.net",
    `/get?q=${encodeURIComponent(text)}&langpair=en|uk`
  );

  return res.responseData.translatedText;
};

/* ================= FORMAT (ОСНОВНА ЗМІНА) ================= */

const escapeHtml = (t) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const buildText = async (article) => {
  const title = await translate(article.title);
  const desc = await translate(article.description);

  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(desc)}`;
};

/* ================= SLOT ================= */

async function sendDraft() {
  if (!currentSlot) return;

  if (currentSlot.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    currentSlot = null;
    return;
  }

  currentSlot.attempts++;

  const news = await getNews();

  const article = news.find((n) => !isSeen(n.url));

  if (!article) return;

  markSeen(article.url);

  const text = await buildText(article);
  const id = nextDraftId();

  currentSlot.pendingId = id;
  currentSlot.text = text;

  await sendMessage(PRIVATE_CHAT_ID, text, [
    { text: "✅ Опублікувати", callback_data: "publish|" + id },
    { text: "❌ Інша", callback_data: "reject|" + id },
  ]);
}

/* ================= CALLBACK ================= */

async function handleUpdates() {
  const res = await tg(`/getUpdates?offset=${lastUpdateId + 1}`);

  if (!res.result) return;

  for (const u of res.result) {
    lastUpdateId = u.update_id;

    if (!u.callback_query) continue;

    const [action, id] = u.callback_query.data.split("|");

    if (!currentSlot || id !== currentSlot.pendingId) {
      await answer(u.callback_query.id, "Неактуально");
      continue;
    }

    if (action === "publish") {
      await sendMessage(CHANNEL_CHAT_ID, currentSlot.text);
      await answer(u.callback_query.id, "Опубліковано ✅");
      currentSlot = null;
    }

    if (action === "reject") {
      await answer(u.callback_query.id, "Інша новина...");
      await sendDraft();
    }
  }
}

/* ================= TIME ================= */

function nowKyiv() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);

  const h = parts.find((p) => p.type === "hour").value;
  const m = parts.find((p) => p.type === "minute").value;

  return `${h}:${m}`;
}

async function scheduler() {
  const time = nowKyiv();

  if (!SCHEDULE_TIMES.includes(time)) return;
  if (currentSlot) return;

  currentSlot = { attempts: 0 };
  await sendDraft();
}

/* ================= START ================= */

console.log("Bot started");

setInterval(handleUpdates, 3000);
setInterval(scheduler, 30000);
