const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "19:05"];
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
      return {
        seenUrls: [],
        processedSlots: [],
        draftCounter: 0,
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      seenUrls: Array.isArray(parsed.seenUrls) ? parsed.seenUrls : [],
      processedSlots: Array.isArray(parsed.processedSlots) ? parsed.processedSlots : [],
      draftCounter: Number.isInteger(parsed.draftCounter) ? parsed.draftCounter : 0,
    };
  } catch (error) {
    console.error("loadState error:", error);
    return {
      seenUrls: [],
      processedSlots: [],
      draftCounter: 0,
    };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("saveState error:", error);
  }
}

function normalizeUrl(input) {
  try {
    const url = new URL(input);
    url.hash = "";

    const paramsToDelete = [];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower === "fbclid" ||
        lower === "gclid" ||
        lower === "mc_cid" ||
        lower === "mc_eid"
      ) {
        paramsToDelete.push(key);
      }
    }

    for (const key of paramsToDelete) {
      url.searchParams.delete(key);
    }

    const query = url.searchParams.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return String(input || "").trim();
  }
}

function isSeen(url) {
  const normalized = normalizeUrl(url);
  return !!normalized && state.seenUrls.includes(normalized);
}

function markSeen(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return;

  if (!state.seenUrls.includes(normalized)) {
    state.seenUrls.push(normalized);

    if (state.seenUrls.length > 1000) {
      state.seenUrls = state.seenUrls.slice(-1000);
    }

    saveState();
  }
}

function nextDraftId() {
  state.draftCounter += 1;
  saveState();
  return String(state.draftCounter);
}

function markSlotProcessed(slotKey) {
  if (!state.processedSlots.includes(slotKey)) {
    state.processedSlots.push(slotKey);

    if (state.processedSlots.length > 300) {
      state.processedSlots = state.processedSlots.slice(-300);
    }

    saveState();
  }
}

function isSlotProcessed(slotKey) {
  return state.processedSlots.includes(slotKey);
}

/* ================= HELPERS ================= */

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getKyivDateTime() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date());
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeLabel: `${map.hour}:${map.minute}`,
  };
}

/* ================= REQUEST ================= */

const sendRequest = (hostname, pathValue, data = null, method = "GET") => {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;

    const options = {
      hostname,
      path: pathValue,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body ? Buffer.byteLength(body) : 0,
        "User-Agent": "ai-telegram-bot",
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve(parsed);
        } catch (error) {
          console.error("JSON parse error:", responseData);
          reject(error);
        }
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
};

const tg = (pathValue, data = null, method = "GET") => {
  return sendRequest("api.telegram.org", `/bot${TOKEN}${pathValue}`, data, method);
};

/* ================= TELEGRAM ================= */

const sendMessage = async (chatId, text, buttons = null) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: [buttons],
    };
  }

  const result = await tg("/sendMessage", payload, "POST");
  console.log("sendMessage:", JSON.stringify(result));
  return result;
};

const answer = async (callbackQueryId, text) => {
  const result = await tg(
    "/answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      text,
    },
    "POST"
  );

  console.log("answerCallbackQuery:", JSON.stringify(result));
  return result;
};

const removeInlineButtons = async (chatId, messageId) => {
  try {
    const result = await tg(
      "/editMessageReplyMarkup",
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [],
        },
      },
      "POST"
    );

    console.log("editMessageReplyMarkup:", JSON.stringify(result));
  } catch (error) {
    console.error("removeInlineButtons error:", error);
  }
};

/* ================= NEWS ================= */

const getNews = async () => {
  const query = encodeURIComponent("(crypto OR bitcoin OR ethereum OR blockchain)");

  const result = await sendRequest(
    "newsapi.org",
    `/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=${NEWS_PAGE_SIZE}&apiKey=${NEWS_API_KEY}`,
    null,
    "GET"
  );

  console.log("NewsAPI raw response:", JSON.stringify(result));

  if (!result || result.status !== "ok" || !Array.isArray(result.articles)) {
    const message =
      result && result.message
        ? result.message
        : "NewsAPI returned invalid response";

    throw new Error(message);
  }

  return result.articles
    .filter((a) => a && a.url && a.title)
    .map((a) => ({
      title: a.title || "Без заголовка",
      description: a.description || "Опис відсутній",
      url: normalizeUrl(a.url || ""),
    }));
};

const getNextUniqueArticle = async () => {
  const news = await getNews();

  for (const article of news) {
    if (!article.url) continue;
    if (isSeen(article.url)) continue;
    return article;
  }

  return null;
};

const translate = async (text) => {
  const source = String(text || "").trim();
  if (!source) return "";

  try {
    const res = await sendRequest(
      "api.mymemory.translated.net",
      `/get?q=${encodeURIComponent(source)}&langpair=en|uk`,
      null,
      "GET"
    );

    return res?.responseData?.translatedText || source;
  } catch (error) {
    console.error("translate error:", error);
    return source;
  }
};

/* ================= FORMAT ================= */

const buildText = async (article) => {
  const title = await translate(article.title);
  const desc = await translate(article.description);

  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(desc || "")}`;
};

/* ================= SLOT ================= */

async function sendDraft() {
  if (!currentSlot) return;
  if (currentSlot.completed) return;

  if (currentSlot.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Ліміт спроб для слота ${currentSlot.timeLabel} вичерпано. Чекаю наступного слота.`
    );
    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    return;
  }

  currentSlot.attempts += 1;

  let article;
  try {
    article = await getNextUniqueArticle();
  } catch (error) {
    console.error("getNextUniqueArticle error:", error);

    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Не вдалося отримати новину: ${escapeHtml(error.message)}`
    );

    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    return;
  }

  if (!article) {
    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Унікальних новин не знайдено для слота ${currentSlot.timeLabel}.`
    );

    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    return;
  }

  markSeen(article.url);

  let text;
  try {
    text = await buildText(article);
  } catch (error) {
    console.error("buildText error:", error);
    text = `<b>${escapeHtml(article.title)}</b>\n\n${escapeHtml(article.description || "")}`;
  }

  const draftId = nextDraftId();

  currentSlot.pendingId = draftId;
  currentSlot.article = article;
  currentSlot.text = text;

  await sendMessage(PRIVATE_CHAT_ID, text, [
    { text: "✅ Опублікувати", callback_data: "publish|" + draftId },
    { text: "❌ Інша", callback_data: "reject|" + draftId },
  ]);

  console.log(
    `Draft sent. slot=${currentSlot.slotKey}, attempt=${currentSlot.attempts}, url=${article.url}`
  );
}

/* ================= CALLBACK ================= */

async function handleUpdates() {
  const res = await tg(`/getUpdates?offset=${lastUpdateId + 1}`);

  if (!res.ok || !Array.isArray(res.result) || !res.result.length) return;

  for (const u of res.result) {
    lastUpdateId = u.update_id;

    if (!u.callback_query) continue;

    const callback = u.callback_query;
    const [action, id] = String(callback.data || "").split("|");

    if (!currentSlot || !currentSlot.pendingId || id !== currentSlot.pendingId) {
      await answer(callback.id, "Неактуально");
      if (callback.message) {
        await removeInlineButtons(callback.message.chat.id, callback.message.message_id);
      }
      continue;
    }

    if (action === "publish") {
      try {
        await sendMessage(CHANNEL_CHAT_ID, currentSlot.text);
        await answer(callback.id, "Опубліковано ✅");

        if (callback.message) {
          await removeInlineButtons(callback.message.chat.id, callback.message.message_id);
        }

        currentSlot.completed = true;
        markSlotProcessed(currentSlot.slotKey);
        currentSlot = null;
      } catch (error) {
        console.error("publish error:", error);
        await answer(callback.id, "Помилка публікації");
      }

      continue;
    }

    if (action === "reject") {
      try {
        await answer(callback.id, "Шукаю іншу новину...");
        if (callback.message) {
          await removeInlineButtons(callback.message.chat.id, callback.message.message_id);
        }

        currentSlot.pendingId = null;
        currentSlot.article = null;
        currentSlot.text = null;

        await sendDraft();
      } catch (error) {
        console.error("reject error:", error);
        await answer(callback.id, "Помилка");
      }
    }
  }
}

/* ================= SCHEDULER ================= */

async function scheduler() {
  const { dateKey, timeLabel } = getKyivDateTime();
  const slotKey = `${dateKey}_${timeLabel}`;

  console.log("scheduler tick:", { dateKey, timeLabel });

  if (!SCHEDULE_TIMES.includes(timeLabel)) {
    return;
  }

  if (isSlotProcessed(slotKey)) {
    return;
  }

  if (currentSlot && !currentSlot.completed) {
    console.log("Slot already active:", currentSlot.slotKey);
    return;
  }

  currentSlot = {
    slotKey,
    dateKey,
    timeLabel,
    attempts: 0,
    completed: false,
    pendingId: null,
    article: null,
    text: null,
  };

  await sendDraft();
}

/* ================= START ================= */

async function bootstrap() {
  if (!TOKEN) {
    throw new Error("TELEGRAM_TOKEN is not set");
  }

  if (!NEWS_API_KEY) {
    throw new Error("NEWS_API_KEY is not set");
  }

  console.log("Bot started");
  console.log("Schedule:", SCHEDULE_TIMES.join(", "));
  console.log("Timezone:", TIMEZONE);

  setInterval(() => {
    handleUpdates().catch((error) => {
      console.error("handleUpdates error:", error);
    });
  }, 3000);

  setInterval(() => {
    scheduler().catch((error) => {
      console.error("scheduler error:", error);
    });
  }, 30000);

  scheduler().catch((error) => {
    console.error("initial scheduler error:", error);
  });
}

bootstrap().catch((error) => {
  console.error("bootstrap error:", error);
  process.exit(1);
});
