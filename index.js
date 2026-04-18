const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const PORT = Number(process.env.PORT || 3000);

const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "14:16"];

const MAX_ATTEMPTS_PER_SLOT = 5;
const NEWS_PAGE_SIZE = 30;
const STATE_FILE = path.join(__dirname, "bot_state.json");

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

function buildTelegramHtml(title, text, sourceUrl = "") {
  const finalTitle = cleanupTitle(title);
  const finalText = stripHtml(text);

  let result = "";

  if (finalTitle) {
    result += `<b>${escapeHtml(finalTitle)}</b>`;
  }

  if (finalText) {
    result += `${result ? "\n\n" : ""}${escapeHtml(finalText)}`;
  }

  if (sourceUrl) {
    result += `${result ? "\n\n" : ""}<a href="${escapeHtml(sourceUrl)}">Джерело</a>`;
  }

  return result.trim();
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

function slotKeyForTime(dateKey, timeLabel) {
  return `${dateKey}_${timeLabel}`;
}

function isScheduledTime(timeLabel) {
  return SCHEDULE_TIMES.includes(timeLabel);
}

/* ================= REQUEST ================= */

function sendRequest(hostname, pathValue, data = null, method = "GET") {
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
}

function tg(pathValue, data = null, method = "GET") {
  return sendRequest("api.telegram.org", `/bot${TOKEN}${pathValue}`, data, method);
}

function telegramMultipartRequest(methodName, fields = {}, file = null) {
  return new Promise((resolve, reject) => {
    const boundary = `----NodeTelegramBoundary${Date.now()}`;
    const chunks = [];

    const appendField = (name, value) => {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
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

async function sendMessage(chatId, text) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };

  const result = await tg("/sendMessage", payload, "POST");
  console.log("sendMessage:", JSON.stringify(result));
  return result;
}

async function sendPhotoToTelegram(chatId, captionHtml, imageBuffer, mimeType) {
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
}

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

async function getNews() {
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
      result && result.message ? result.message : "NewsAPI returned invalid response";
    throw new Error(message);
  }

  return result.articles
    .filter((a) => a && a.url && a.title)
    .map((a) => ({
      title: cleanupTitle(a.title || "Без заголовка"),
      description: stripHtml(a.description || ""),
      fullText: stripHtml(a.content || a.description || ""),
      url: normalizeUrl(a.url || ""),
      publishedAt: a.publishedAt || "",
      sourceName: a.source?.name || "",
      score: scoreArticle(a),
    }))
    .filter(isGoodCryptoArticle)
    .sort((a, b) => b.score - a.score);
}

async function getNextUniqueArticle() {
  const news = await getNews();

  for (const article of news) {
    if (!article.url) continue;
    if (isSeen(article.url)) continue;
    return article;
  }

  return null;
}

async function translate(text) {
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
}

/* ================= DRAFT BUILD ================= */

async function buildDraft(article) {
  const translatedTitle = await translate(article.title);
  const sourceText = article.fullText || article.description || "";
  const translatedText = sourceText ? await translate(sourceText) : "";

  return {
    title: cleanupTitle(translatedTitle || article.title),
    text: stripHtml(translatedText || sourceText),
  };
}

/* ================= SLOT ================= */

async function createDraftForCurrentSlot() {
  if (!currentSlot) return null;
  if (currentSlot.completed) return null;

  if (currentSlot.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return null;
  }

  currentSlot.attempts += 1;

  let article;
  try {
    article = await getNextUniqueArticle();
  } catch (error) {
    console.error("getNextUniqueArticle error:", error);
    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return null;
  }

  if (!article) {
    currentSlot.completed = true;
    markSlotProcessed(currentSlot.slotKey);
    currentSlot = null;
    currentDraft = null;
    return null;
  }

  markSeen(article.url);

  let draftContent;
  try {
    draftContent = await buildDraft(article);
  } catch (error) {
    console.error("buildDraft error:", error);
    draftContent = {
      title: cleanupTitle(article.title),
      text: stripHtml(article.fullText || article.description || ""),
    };
  }

  const draftId = nextDraftId();

  currentDraft = {
    id: draftId,
    title: draftContent.title,
    description: article.description,
    text: draftContent.text,
    url: article.url,
    sourceName: article.sourceName || "",
    publishedAt: article.publishedAt || "",
    slotKey: currentSlot.slotKey,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  currentSlot.pendingId = draftId;
  currentSlot.article = article;

  console.log(
    `Draft created. slot=${currentSlot.slotKey}, attempt=${currentSlot.attempts}, url=${article.url}`
  );

  return currentDraft;
}

function ensureCurrentSlot() {
  const { dateKey, timeLabel } = getKyivDateTime();
  const key = slotKeyForTime(dateKey, timeLabel);

  if (!isScheduledTime(timeLabel)) {
    return false;
  }

  if (isSlotProcessed(key)) {
    return false;
  }

  if (currentSlot && currentSlot.slotKey === key && !currentSlot.completed) {
    return true;
  }

  currentSlot = {
    slotKey: key,
    dateKey,
    timeLabel,
    attempts: 0,
    completed: false,
    pendingId: null,
    article: null,
  };

  return true;
}

async function ensureDraftAvailable() {
  if (currentDraft && currentDraft.status === "pending") {
    return currentDraft;
  }

  const hasSlot = ensureCurrentSlot();
  if (!hasSlot) return null;

  return createDraftForCurrentSlot();
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
      service: "crypto-news-bot",
      hasDraft: !!currentDraft,
      currentSlot: currentSlot?.slotKey || null,
    });
  }

  if (req.method === "GET" && req.url === "/draft/current") {
    try {
      const draft = await ensureDraftAvailable();

      if (!draft) {
        return sendJson(res, 200, {
          ok: true,
          draft: null,
          message: "Наразі немає активної чернетки",
        });
      }

      return sendJson(res, 200, {
        ok: true,
        draft,
      });
    } catch (error) {
      console.error("/draft/current error:", error);
      return sendJson(res, 500, {
        ok: false,
        error: "Не вдалося отримати чернетку",
      });
    }
  }

  if (req.method === "POST" && req.url === "/draft/reject") {
    try {
      if (!currentSlot || currentSlot.completed) {
        const draft = await ensureDraftAvailable();

        if (!draft) {
          return sendJson(res, 200, {
            ok: false,
            message: "Немає активної чернетки для заміни",
          });
        }

        return sendJson(res, 200, {
          ok: true,
          message: "Нова чернетка створена",
          draft,
        });
      }

      currentDraft = null;

      const draft = await createDraftForCurrentSlot();

      if (!draft) {
        return sendJson(res, 200, {
          ok: false,
          message: "Інших новин для цього слоту не знайдено",
        });
      }

      return sendJson(res, 200, {
        ok: true,
        message: "Нова чернетка створена",
        draft,
      });
    } catch (error) {
      console.error("/draft/reject error:", error);
      return sendJson(res, 500, {
        ok: false,
        error: "Не вдалося відхилити чернетку",
      });
    }
  }

  if (req.method === "POST" && req.url === "/draft/publish") {
    try {
      const body = await parseRequestBody(req);

      const title = cleanupTitle(body.title || currentDraft?.title || "");
      const text = stripHtml(body.text || currentDraft?.text || "");
      const imageBase64 = sanitizeBase64(body.imageBase64 || "");
      const imageMimeType = String(body.imageMimeType || "image/jpeg");

      if (!title && !text) {
        return sendJson(res, 400, {
          ok: false,
          error: "Порожній текст публікації",
        });
      }

      const sourceUrl = currentDraft?.url || "";
      const html = buildTelegramHtml(title, text, sourceUrl);

      let tgResult;

      if (imageBase64) {
        const imageBuffer = Buffer.from(imageBase64, "base64");
        tgResult = await sendPhotoToTelegram(
          CHANNEL_CHAT_ID,
          html,
          imageBuffer,
          imageMimeType
        );
      } else {
        tgResult = await sendMessage(CHANNEL_CHAT_ID, html);
      }

      if (!tgResult || !tgResult.ok) {
        return sendJson(res, 500, {
          ok: false,
          error: tgResult?.description || "Telegram publish failed",
        });
      }

      if (currentSlot?.slotKey) {
        markSlotProcessed(currentSlot.slotKey);
      }

      if (currentDraft) {
        currentDraft.status = "published";
      }

      currentDraft = null;
      currentSlot = null;

      return sendJson(res, 200, {
        ok: true,
        message: "Опубліковано",
      });
    } catch (error) {
      console.error("/draft/publish error:", error);
      return sendJson(res, 500, {
        ok: false,
        error: error?.message || "Помилка публікації",
      });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found",
  });
});

/* ================= SCHEDULER ================= */

function tickScheduler() {
  try {
    if (currentDraft && currentDraft.status === "pending") {
      return;
    }

    const { dateKey, timeLabel } = getKyivDateTime();
    const key = slotKeyForTime(dateKey, timeLabel);

    if (!isScheduledTime(timeLabel)) {
      return;
    }

    if (isSlotProcessed(key)) {
      return;
    }

    if (!currentSlot || currentSlot.slotKey !== key) {
      currentSlot = {
        slotKey: key,
        dateKey,
        timeLabel,
        attempts: 0,
        completed: false,
        pendingId: null,
        article: null,
      };
    }

    if (!currentDraft) {
      createDraftForCurrentSlot().catch((error) => {
        console.error("scheduler createDraftForCurrentSlot error:", error);
      });
    }
  } catch (error) {
    console.error("tickScheduler error:", error);
  }
}

/* ================= START ================= */

apiServer.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});

setInterval(tickScheduler, 30 * 1000);
tickScheduler();
