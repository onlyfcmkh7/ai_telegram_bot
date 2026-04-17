const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "18:50"];
const MAX_ATTEMPTS_PER_SLOT = 5;
const NEWS_PAGE_SIZE = 15;
const STATE_FILE = path.join(__dirname, "bot_state.json");

let lastUpdateId = 0;

let currentSlot = null;
/*
currentSlot = {
  slotKey: "2026-04-17_11:00",
  dateKey: "2026-04-17",
  timeLabel: "11:00",
  attempts: 0,
  completed: false,
  pendingDraftId: null,
  pendingArticle: null,
  pendingText: null
}
*/

const state = loadState();

/* =========================
   BASIC HELPERS
========================= */

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        seenUrls: [],
        publishedUrls: [],
        processedSlots: [],
        draftCounter: 0,
      };
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      seenUrls: Array.isArray(parsed.seenUrls) ? parsed.seenUrls : [],
      publishedUrls: Array.isArray(parsed.publishedUrls) ? parsed.publishedUrls : [],
      processedSlots: Array.isArray(parsed.processedSlots) ? parsed.processedSlots : [],
      draftCounter: Number.isInteger(parsed.draftCounter) ? parsed.draftCounter : 0,
    };
  } catch (error) {
    console.error("loadState error:", error);
    return {
      seenUrls: [],
      publishedUrls: [],
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
    return (input || "").trim();
  }
}

function markUrlSeen(url) {
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

function markUrlPublished(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return;

  if (!state.publishedUrls.includes(normalized)) {
    state.publishedUrls.push(normalized);

    if (state.publishedUrls.length > 1000) {
      state.publishedUrls = state.publishedUrls.slice(-1000);
    }

    saveState();
  }
}

function isUrlSeen(url) {
  const normalized = normalizeUrl(url);
  return !!normalized && state.seenUrls.includes(normalized);
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

function nextDraftId() {
  state.draftCounter += 1;
  saveState();
  return String(state.draftCounter);
}

function getKyivNowParts() {
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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* =========================
   HTTP / TELEGRAM
========================= */

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
        "User-Agent": "my-crypto-bot",
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (error) {
          console.error("PARSE ERROR:", responseData);
          reject(error);
        }
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
};

const telegramRequest = (pathValue, data = null, method = "GET") => {
  return sendRequest("api.telegram.org", `/bot${TOKEN}${pathValue}`, data, method);
};

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

  const result = await telegramRequest("/sendMessage", payload, "POST");
  console.log("sendMessage:", JSON.stringify(result));
  return result;
};

const answerCallbackQuery = async (callbackQueryId, text) => {
  const result = await telegramRequest(
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
    const result = await telegramRequest(
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

/* =========================
   NEWS / TRANSLATION
========================= */

const getCryptoNewsCandidates = async () => {
  const query = encodeURIComponent("(crypto OR bitcoin OR ethereum OR blockchain)");
  const pathValue =
    `/v2/everything` +
    `?q=${query}` +
    `&language=en` +
    `&sortBy=publishedAt` +
    `&pageSize=${NEWS_PAGE_SIZE}` +
    `&apiKey=${NEWS_API_KEY}`;

  const result = await sendRequest("newsapi.org", pathValue, null, "GET");

  if (!result.articles || !result.articles.length) {
    throw new Error("No crypto news found");
  }

  return result.articles.map((article) => ({
    title: article.title || "Без заголовка",
    description: article.description || "Опис відсутній",
    url: normalizeUrl(article.url || ""),
  }));
};

const getNextUniqueArticle = async () => {
  const articles = await getCryptoNewsCandidates();

  for (const article of articles) {
    if (!article.url) continue;
    if (isUrlSeen(article.url)) continue;

    return article;
  }

  return null;
};

const translateToUkrainian = async (text) => {
  const source = String(text || "").trim();
  if (!source) return "";

  const query = encodeURIComponent(source);

  const result = await sendRequest(
    "api.mymemory.translated.net",
    `/get?q=${query}&langpair=en|uk`,
    null,
    "GET"
  );

  return result.responseData?.translatedText || source;
};

const buildDraftText = async (article) => {
  const title = await translateToUkrainian(article.title);
  const description = await translateToUkrainian(article.description);

  return (
    `📰 <b>Крипто-новина</b>\n\n` +
    `${escapeHtml(title)}\n\n` +
    `${escapeHtml(description)}`
  );
};

/* =========================
   SLOT LOGIC
========================= */

async function startSlot(slotKey, dateKey, timeLabel) {
  currentSlot = {
    slotKey,
    dateKey,
    timeLabel,
    attempts: 0,
    completed: false,
    pendingDraftId: null,
    pendingArticle: null,
    pendingText: null,
  };

  console.log(`Starting slot ${slotKey}`);
  await sendNextDraftForCurrentSlot();
}

function finishCurrentSlot() {
  if (!currentSlot) return;

  console.log(`Finishing slot ${currentSlot.slotKey}`);
  markSlotProcessed(currentSlot.slotKey);
  currentSlot.completed = true;
  currentSlot.pendingDraftId = null;
  currentSlot.pendingArticle = null;
  currentSlot.pendingText = null;
  currentSlot = null;
}

async function sendNextDraftForCurrentSlot() {
  if (!currentSlot || currentSlot.completed) return;

  if (currentSlot.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Для слота ${currentSlot.timeLabel} вичерпано ліміт спроб (${MAX_ATTEMPTS_PER_SLOT}). Чекаю наступного слота.`
    );
    finishCurrentSlot();
    return;
  }

  currentSlot.attempts += 1;

  let article = null;

  try {
    article = await getNextUniqueArticle();
  } catch (error) {
    console.error("getNextUniqueArticle error:", error);
    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Не вдалося отримати новину для слота ${currentSlot.timeLabel}.`
    );
    finishCurrentSlot();
    return;
  }

  if (!article) {
    await sendMessage(
      PRIVATE_CHAT_ID,
      `⚠️ Унікальні новини для слота ${currentSlot.timeLabel} не знайдені. Чекаю наступного слота.`
    );
    finishCurrentSlot();
    return;
  }

  markUrlSeen(article.url);

  let draftText = "";
  try {
    draftText = await buildDraftText(article);
  } catch (error) {
    console.error("buildDraftText error:", error);
    draftText =
      `📰 <b>Крипто-новина</b>\n\n` +
      `${escapeHtml(article.title)}\n\n` +
      `${escapeHtml(article.description)}`;
  }

  const draftId = nextDraftId();

  currentSlot.pendingDraftId = draftId;
  currentSlot.pendingArticle = article;
  currentSlot.pendingText = draftText;

  await sendMessage(PRIVATE_CHAT_ID, draftText, [
    { text: "✅ Опублікувати", callback_data: `publish|${draftId}` },
    { text: "❌ Відхилити", callback_data: `reject|${draftId}` },
  ]);

  console.log(
    `Draft sent for slot ${currentSlot.slotKey}, attempt ${currentSlot.attempts}, url=${article.url}`
  );
}

/* =========================
   CALLBACKS / UPDATES
========================= */

async function handlePublish(callback, draftId) {
  const callbackId = callback.id;
  const message = callback.message;

  if (!currentSlot || !currentSlot.pendingDraftId || currentSlot.completed) {
    await answerCallbackQuery(callbackId, "Активного чернеткового поста вже немає");
    return;
  }

  if (draftId !== currentSlot.pendingDraftId) {
    await answerCallbackQuery(callbackId, "Ця кнопка вже неактуальна");
    await removeInlineButtons(message.chat.id, message.message_id);
    return;
  }

  try {
    await sendMessage(CHANNEL_CHAT_ID, currentSlot.pendingText);
    markUrlPublished(currentSlot.pendingArticle.url);

    await answerCallbackQuery(callbackId, "Опубліковано в канал ✅");
    await removeInlineButtons(message.chat.id, message.message_id);

    finishCurrentSlot();
  } catch (error) {
    console.error("handlePublish error:", error);
    await answerCallbackQuery(callbackId, "Помилка під час публікації");
  }
}

async function handleReject(callback, draftId) {
  const callbackId = callback.id;
  const message = callback.message;

  if (!currentSlot || !currentSlot.pendingDraftId || currentSlot.completed) {
    await answerCallbackQuery(callbackId, "Активного чернеткового поста вже немає");
    return;
  }

  if (draftId !== currentSlot.pendingDraftId) {
    await answerCallbackQuery(callbackId, "Ця кнопка вже неактуальна");
    await removeInlineButtons(message.chat.id, message.message_id);
    return;
  }

  try {
    await answerCallbackQuery(callbackId, "Шукаю іншу новину ❌");
    await removeInlineButtons(message.chat.id, message.message_id);

    currentSlot.pendingDraftId = null;
    currentSlot.pendingArticle = null;
    currentSlot.pendingText = null;

    await sendNextDraftForCurrentSlot();
  } catch (error) {
    console.error("handleReject error:", error);
    await answerCallbackQuery(callbackId, "Помилка під час відхилення");
  }
}

const handleUpdates = async () => {
  const result = await telegramRequest(`/getUpdates?offset=${lastUpdateId + 1}`);

  if (!result.ok || !result.result || !result.result.length) return;

  for (const update of result.result) {
    lastUpdateId = update.update_id;

    if (!update.callback_query) continue;

    const callback = update.callback_query;
    const data = String(callback.data || "");
    const [action, draftId] = data.split("|");

    if (action === "publish") {
      await handlePublish(callback, draftId);
      continue;
    }

    if (action === "reject") {
      await handleReject(callback, draftId);
      continue;
    }
  }
};

/* =========================
   SCHEDULER
========================= */

async function checkSchedule() {
  const { dateKey, timeLabel } = getKyivNowParts();

  if (!SCHEDULE_TIMES.includes(timeLabel)) {
    return;
  }

  const slotKey = `${dateKey}_${timeLabel}`;

  if (isSlotProcessed(slotKey)) {
    return;
  }

  if (currentSlot && currentSlot.slotKey === slotKey) {
    return;
  }

  if (currentSlot && !currentSlot.completed) {
    console.log(
      `Slot ${slotKey} skipped because current slot ${currentSlot.slotKey} is still active`
    );
    return;
  }

  try {
    await startSlot(slotKey, dateKey, timeLabel);
  } catch (error) {
    console.error("checkSchedule/startSlot error:", error);
  }
}

/* =========================
   START
========================= */

async function bootstrap() {
  if (!TOKEN) {
    throw new Error("TELEGRAM_TOKEN is not set");
  }

  if (!NEWS_API_KEY) {
    throw new Error("NEWS_API_KEY is not set");
  }

  console.log("Bot started");
  console.log(`Timezone: ${TIMEZONE}`);
  console.log(`Schedule: ${SCHEDULE_TIMES.join(", ")}`);

  setInterval(() => {
    handleUpdates().catch((error) => {
      console.error("handleUpdates error:", error);
    });
  }, 3000);

  setInterval(() => {
    checkSchedule().catch((error) => {
      console.error("checkSchedule error:", error);
    });
  }, 30000);

  // Одразу перевіряємо при старті, щоб не чекати перші 30 секунд
  checkSchedule().catch((error) => {
    console.error("initial checkSchedule error:", error);
  });
}

bootstrap().catch((error) => {
  console.error("bootstrap error:", error);
  process.exit(1);
});
