const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const PORT = process.env.PORT || 3000;

const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "18:00"];

const MAX_ATTEMPTS_PER_SLOT = 5;
const NEWS_PAGE_SIZE = 30;
const STATE_FILE = path.join(__dirname, "bot_state.json");

let lastUpdateId = 0;
let currentSlot = null;
let currentDraft = null;

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

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(text, maxLength = 220) {
  const cleaned = stripHtml(text);
  if (!cleaned) return "";

  if (cleaned.length <= maxLength) return cleaned;

  const sliced = cleaned.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");

  if (lastSpace > 120) {
    return `${sliced.slice(0, lastSpace)}…`;
  }

  return `${sliced}…`;
}

function cleanupTitle(text) {
  return stripHtml(text)
    .replace(/\s*[-–|]\s*[^-–|]+$/, "")
    .trim();
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

function sendJson(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  res.end(JSON.stringify(payload));
}

function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function buildPostHtml(title, text) {
  const finalTitle = typeof title === "string" ? cleanupTitle(title) : "";
  const finalText = typeof text === "string" ? stripHtml(text) : "";

  if (finalTitle && finalText) {
    return `<b>${escapeHtml(finalTitle)}</b>\n\n${escapeHtml(finalText)}`;
  }

  if (finalTitle) {
    return `<b>${escapeHtml(finalTitle)}</b>`;
  }

  if (finalText) {
    return escapeHtml(finalText);
  }

  return "";
}

function getExtensionFromMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();

  if (value.includes("png")) return "png";
  if (value.includes("webp")) return "webp";
  if (value.includes("jpg") || value.includes("jpeg")) return "jpg";

  return "jpg";
}

function sanitizeBase64(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const commaIndex = raw.indexOf(",");
  if (commaIndex !== -1) {
    return raw.slice(commaIndex + 1).trim();
  }

  return raw;
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

function telegramMultipartRequest(methodName, fields = {}, file = null) {
  return new Promise((resolve, reject) => {
    const boundary = `----NodeTelegramBoundary${Date.now()}`;
    const chunks = [];

    const appendField = (name, value) => {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`)
      );
      chunks.push(Buffer.from(String(value)));
      chunks.push(Buffer.from("\r\n"));
    };

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      appendField(key, value);
    }

    if (file && file.buffer) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n`
        )
      );
      chunks.push(
        Buffer.from(`Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`)
      );
      chunks.push(file.buffer);
      chunks.push(Buffer.from("\r\n"));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/${methodName}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
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
          console.error("telegramMultipartRequest parse error:", responseData);
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

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

const sendPhotoToTelegram = async (chatId, captionHtml, imageBuffer, mimeType) => {
  const ext = getExtensionFromMime(mimeType);
  const result = await telegramMultipartRequest(
    "sendPhoto",
    {
      chat_id: chatId,
      caption: captionHtml,
      parse_mode: "HTML",
    },
    {
      fieldName: "photo",
      filename: `post.${ext}`,
      contentType: mimeType || "image/jpeg",
      buffer: imageBuffer,
    }
  );

  console.log("sendPhoto:", JSON.stringify(result));
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

/* ================= NEWS FILTER ================= */

const POSITIVE_KEYWORDS = [
  "crypto",
  "cryptocurrency",
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "solana",
  "sol",
  "binance",
  "coinbase",
  "blockchain",
  "web3",
  "defi",
  "stablecoin",
  "stablecoins",
  "token",
  "tokens",
  "altcoin",
  "altcoins",
  "etf",
  "xrp",
  "dogecoin",
  "ton",
  "tron",
  "kraken",
  "metamask",
];

const NEGATIVE_KEYWORDS = [
  "app store",
  "iphone",
  "ios",
  "android app",
  "virus protection",
  "scammer",
  "scam app",
  "anthropic",
  "claude",
  "pypi",
  "sdk",
  "railroad commissioner",
  "iran",
  "lebanon",
  "hezbollah",
  "ceasefire",
  "uranium",
  "import prices",
  "biden pardons",
  "doha",
  "trump dismisses",
];

function scoreArticle(article) {
  const haystack = `${article.title || ""} ${article.description || ""}`.toLowerCase();
  let score = 0;

  for (const word of POSITIVE_KEYWORDS) {
    if (haystack.includes(word)) score += 2;
  }

  for (const word of NEGATIVE_KEYWORDS) {
    if (haystack.includes(word)) score -= 5;
  }

  if (haystack.includes("bitcoin")) score += 3;
  if (haystack.includes("ethereum")) score += 3;
  if (haystack.includes("crypto")) score += 3;
  if (haystack.includes("blockchain")) score += 2;
  if (haystack.includes("etf")) score += 2;

  return score;
}

function isGoodCryptoArticle(article) {
  const haystack = `${article.title || ""} ${article.description || ""}`.toLowerCase();

  const hasPositive = POSITIVE_KEYWORDS.some((word) => haystack.includes(word));
  const hasNegative = NEGATIVE_KEYWORDS.some((word) => haystack.includes(word));

  if (!hasPositive) return false;
  if (hasNegative) return false;

  return scoreArticle(article) >= 4;
}

/* ================= NEWS ================= */

const getNews = async () => {
  const query = encodeURIComponent(
    '(crypto OR cryptocurrency OR bitcoin OR ethereum OR blockchain OR "crypto market" OR ETF)'
  );

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

  const normalized = result.articles
    .filter((a) => a && a.url && a.title)
    .map((a) => ({
      title: cleanupTitle(a.title || "Без заголовка"),
      description: stripHtml(a.description || ""),
      url: normalizeUrl(a.url || ""),
      publishedAt: a.publishedAt || "",
      sourceName: a.source?.name || "",
      score: scoreArticle(a),
    }))
    .filter(isGoodCryptoArticle)
    .sort((a, b) => b.score - a.score);

  return normalized;
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

    return stripHtml(res?.responseData?.translatedText || source);
  } catch (error) {
    console.error("translate error:", error);
    return source;
  }
};

/* ================= FORMAT ================= */

const buildText = async (article) => {
  const translatedTitle = await translate(article.title);
  let translatedDesc = "";

  if (article.description) {
    translatedDesc = await translate(shorten(article.description, 180));
  }

  const safeTitle = escapeHtml(cleanupTitle(translatedTitle || article.title));
  const safeDesc = escapeHtml(shorten(translatedDesc || article.description || "", 200));

  if (!safeDesc) {
    return `<b>${safeTitle}</b>`;
  }

  return `<b>${safeTitle}</b>\n\n${safeDesc}`;
};

/* ================= SLOT ================= */

async function sendDraft(options = {}) {
  if (!currentSlot) return;
  if (currentSlot.completed) return;

  const silent = !!options.silent;

  if (currentSlot.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    if (!silent) {
      await sendMessage(
        PRIVATE_CHAT_ID,
        `⚠️ Ліміт спроб для слота ${currentSlot.timeLabel} вичерпано. Чекаю наступного слота.`
      );
    }

    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return;
  }

  currentSlot.attempts += 1;

  let article;
  try {
    article = await getNextUniqueArticle();
  } catch (error) {
    console.error("getNextUniqueArticle error:", error);

    if (!silent) {
      await sendMessage(
        PRIVATE_CHAT_ID,
        `⚠️ Не вдалося отримати новину: ${escapeHtml(error.message)}`
      );
    }

    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return;
  }

  if (!article) {
    if (!silent) {
      await sendMessage(
        PRIVATE_CHAT_ID,
        `⚠️ Якісних унікальних крипто-новин не знайдено для слота ${currentSlot.timeLabel}.`
      );
    }

    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return;
  }

  markSeen(article.url);

  let text;
  try {
    text = await buildText(article);
  } catch (error) {
    console.error("buildText error:", error);
    text = `<b>${escapeHtml(article.title)}</b>\n\n${escapeHtml(shorten(article.description || "", 180))}`;
  }

  const draftId = nextDraftId();

  currentSlot.pendingId = draftId;
  currentSlot.article = article;
  currentSlot.text = text;

  currentDraft = {
    id: draftId,
    title: article.title,
    description: article.description,
    text,
    url: article.url,
    slotKey: currentSlot.slotKey,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

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

        if (currentDraft) {
          currentDraft.status = "published";
          currentDraft.publishedAt = new Date().toISOString();
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

        if (currentDraft) {
          currentDraft.status = "rejected";
          currentDraft.rejectedAt = new Date().toISOString();
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

/* ================= API ================= */

const apiServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "ai-telegram-bot",
      endpoints: ["/draft/current", "/draft/test", "/draft/reject", "/draft/publish"],
    });
  }

  if (req.method === "GET" && req.url === "/draft/current") {
    return sendJson(res, 200, {
      ok: true,
      draft: currentDraft,
    });
  }

  if (req.method === "GET" && req.url === "/draft/test") {
    try {
      currentSlot = {
        slotKey: "manual_test_slot",
        dateKey: "manual_test_date",
        timeLabel: "TEST",
        attempts: 0,
        completed: false,
        pendingId: null,
        article: null,
        text: null,
      };

      await sendDraft();

      return sendJson(res, 200, {
        ok: true,
        draft: currentDraft,
      });
    } catch (error) {
      console.error("GET /draft/test error:", error);

      return sendJson(res, 500, {
        ok: false,
        error: error.message || "Failed to create test draft",
      });
    }
  }

  if (req.method === "POST" && req.url === "/draft/reject") {
    try {
      if (!currentSlot || currentSlot.completed) {
        currentSlot = {
          slotKey: "manual_reject_slot",
          dateKey: "manual_reject_date",
          timeLabel: "MANUAL",
          attempts: 0,
          completed: false,
          pendingId: null,
          article: null,
          text: null,
        };
      }

      if (currentDraft) {
        currentDraft.status = "rejected";
        currentDraft.rejectedAt = new Date().toISOString();
      }

      currentSlot.pendingId = null;
      currentSlot.article = null;
      currentSlot.text = null;

      await sendDraft({ silent: true });

      return sendJson(res, 200, {
        ok: true,
        message: "New draft created",
        draft: currentDraft,
      });
    } catch (error) {
      console.error("POST /draft/reject error:", error);
      return sendJson(res, 500, {
        ok: false,
        message: error.message || "Reject failed",
      });
    }
  }

  if (req.method === "POST" && req.url === "/draft/publish") {
    try {
      const body = await parseRequestBody(req);

      if (!currentDraft) {
        return sendJson(res, 400, {
          ok: false,
          error: "No active draft",
        });
      }

      const finalTitle =
        typeof body.title === "string"
          ? cleanupTitle(body.title)
          : cleanupTitle(currentDraft.title || "");

      const finalText =
        typeof body.text === "string"
          ? stripHtml(body.text)
          : stripHtml(currentDraft.description || "");

      const messageHtml = buildPostHtml(finalTitle, finalText);

      if (!messageHtml) {
        return sendJson(res, 400, {
          ok: false,
          error: "Empty post",
        });
      }

      const imageBase64 = sanitizeBase64(body.imageBase64);
      const imageMimeType = String(body.imageMimeType || "image/jpeg").trim();

      if (imageBase64) {
        let imageBuffer;

        try {
          imageBuffer = Buffer.from(imageBase64, "base64");
        } catch (error) {
          return sendJson(res, 400, {
            ok: false,
            error: "Invalid imageBase64",
          });
        }

        if (!imageBuffer || !imageBuffer.length) {
          return sendJson(res, 400, {
            ok: false,
            error: "Empty image",
          });
        }

        const photoResult = await sendPhotoToTelegram(
          CHANNEL_CHAT_ID,
          messageHtml,
          imageBuffer,
          imageMimeType
        );

        if (!photoResult.ok) {
          return sendJson(res, 500, {
            ok: false,
            error: photoResult.description || "Telegram sendPhoto failed",
          });
        }
      } else {
        await sendMessage(CHANNEL_CHAT_ID, messageHtml);
      }

      currentDraft.status = "published";
      currentDraft.publishedAt = new Date().toISOString();

      if (currentSlot) {
        currentSlot.completed = true;
        markSlotProcessed(currentSlot.slotKey);
        currentSlot = null;
      }

      return sendJson(res, 200, {
        ok: true,
        message: "Published",
      });
    } catch (error) {
      console.error("POST /draft/publish error:", error);
      return sendJson(res, 500, {
        ok: false,
        error: error.message || "Publish failed",
      });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found",
  });
});

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

  apiServer.listen(PORT, () => {
    console.log(`API server started on port ${PORT}`);
  });

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
