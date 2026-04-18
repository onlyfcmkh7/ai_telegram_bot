const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const PORT = Number(process.env.PORT || 3000);

const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "18:00"];

const MAX_ATTEMPTS_PER_SLOT = 5;
const NEWS_PAGE_SIZE = 30;
const STATE_FILE = path.join(__dirname, "bot_state.json");

const LIBRETRANSLATE_URL =
  process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000/translate";
const SOURCE_LANG = process.env.SOURCE_LANG || "auto";
const TARGET_LANG = process.env.TARGET_LANG || "uk";

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

function cleanupArticleText(text) {
  return stripHtml(text)
    .replace(/\[\+\d+\s*chars\]/gi, "")
    .replace(/\[\+\d+\s*символ[^\]]*\]/gi, "")
    .replace(/\+\d+\s*chars/gi, "")
    .replace(/Continue reading.*/gi, "")
    .replace(/Read more.*/gi, "")
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

function splitTextIntoChunks(text, maxLen = 450) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [cleaned];
  const chunks = [];
  let current = "";

  for (const part of sentences) {
    const sentence = part.trim();
    if (!sentence) continue;

    if (!current) {
      current = sentence;
      continue;
    }

    const candidate = `${current} ${sentence}`.trim();
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
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

function postJsonAbsolute(rawUrl, data = {}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(rawUrl);
      const body = JSON.stringify(data);
      const client = url.protocol === "http:" ? http : https;

      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "http:" ? 80 : 443),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "ai-telegram-bot",
          },
        },
        (res) => {
          let responseData = "";

          res.on("data", (chunk) => {
            responseData += chunk;
          });

          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (error) {
              console.error("postJsonAbsolute parse error:", responseData);
              reject(error);
            }
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(20000, () => {
        req.destroy(new Error("Request timeout"));
      });
      req.write(body);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

function fetchUrl(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    try {
      if (redirectCount > 5) {
        return reject(new Error("Too many redirects"));
      }

      const url = new URL(rawUrl);
      const client = url.protocol === "http:" ? http : https;

      const req = client.get(
        rawUrl,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const nextUrl = new URL(res.headers.location, rawUrl).toString();
            return resolve(fetchUrl(nextUrl, redirectCount + 1));
          }

          let data = "";

          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            resolve(data);
          });
        }
      );

      req.on("error", reject);

      req.setTimeout(15000, () => {
        req.destroy(new Error("Request timeout"));
      });
    } catch (error) {
      reject(error);
    }
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
  if (!article) return false;

  const title = String(article.title || "").trim();
  const description = String(article.description || "").trim();
  const url = String(article.url || "").trim();

  if (!title || !url) return false;
  if (title === "[Removed]") return false;

  return scoreArticle(article) > 0 || /bitcoin|ethereum|crypto|blockchain|etf|xrp|solana/i.test(`${title} ${description}`);
}

/* ================= NEWS ================= */

async function fetchNews() {
  const q = encodeURIComponent(
    "crypto OR cryptocurrency OR bitcoin OR ethereum OR blockchain OR ETF OR XRP OR Solana"
  );

  const pathValue =
    `/v2/everything?q=${q}` +
    `&language=en` +
    `&sortBy=publishedAt` +
    `&pageSize=${NEWS_PAGE_SIZE}` +
    `&apiKey=${NEWS_API_KEY}`;

  const data = await sendRequest("newsapi.org", pathValue, null, "GET");
  const articles = Array.isArray(data.articles) ? data.articles : [];

  return articles.filter(isGoodCryptoArticle).sort((a, b) => scoreArticle(b) - scoreArticle(a));
}

async function extractArticleText(url) {
  try {
    const html = await fetchUrl(url);
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();

    if (parsed?.textContent) {
      return cleanupArticleText(parsed.textContent);
    }

    const $ = cheerio.load(html);
    const fallbackText = $("article").text() || $("body").text() || "";
    return cleanupArticleText(fallbackText);
  } catch (error) {
    console.error("extractArticleText error:", url, error.message);
    return "";
  }
}

/* ================= TRANSLATE ================= */

async function libreTranslate(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";

  const data = await postJsonAbsolute(LIBRETRANSLATE_URL, {
    q: clean,
    source: SOURCE_LANG,
    target: TARGET_LANG,
    format: "text",
  });

  return String(data?.translatedText || "").trim();
}

async function safeTranslateText(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";

  try {
    const chunks = splitTextIntoChunks(clean, 450);
    if (!chunks.length) return "";

    const translated = [];
    for (const chunk of chunks) {
      try {
        const t = await libreTranslate(chunk);
        translated.push(t || chunk);
      } catch (error) {
        console.error("Chunk translation failed:", error.message);
        translated.push(chunk);
      }
    }

    return translated.join(" ").replace(/\s+/g, " ").trim();
  } catch (error) {
    console.error("safeTranslateText error:", error.message);
    return clean;
  }
}

/* ================= DRAFT ================= */

async function buildDraftFromArticle(article) {
  const normalizedUrl = normalizeUrl(article.url);
  if (!normalizedUrl) return null;
  if (isSeen(normalizedUrl)) return null;

  const rawTitle = cleanupTitle(article.title || "");
  const rawDescription = cleanupArticleText(article.description || "");
  const fullTextRaw = await extractArticleText(normalizedUrl);

  const baseText = fullTextRaw || rawDescription;
  if (!rawTitle || !baseText) return null;

  const translatedTitle = await safeTranslateText(rawTitle);
  const translatedText = await safeTranslateText(baseText);

  return {
    id: nextDraftId(),
    title: translatedTitle || rawTitle,
    description: rawDescription,
    text: translatedText || baseText,
    url: normalizedUrl,
    imageUrl: article.urlToImage || "",
    publishedAt: article.publishedAt || "",
    sourceName: article.source?.name || "",
  };
}

async function buildNextDraft() {
  const articles = await fetchNews();

  for (const article of articles) {
    const normalizedUrl = normalizeUrl(article.url);
    if (!normalizedUrl) continue;
    if (isSeen(normalizedUrl)) continue;
    if (currentDraft?.url && normalizeUrl(currentDraft.url) === normalizedUrl) continue;

    try {
      const draft = await buildDraftFromArticle(article);
      if (draft) return draft;
    } catch (error) {
      console.error("buildNextDraft article error:", normalizedUrl, error.message);
    }
  }

  return null;
}

async function getOrCreateCurrentDraft() {
  if (currentDraft?.url && !isSeen(currentDraft.url)) {
    return currentDraft;
  }

  currentDraft = await buildNextDraft();
  return currentDraft;
}

/* ================= SCHEDULE ================= */

async function processScheduledSlot() {
  try {
    const { dateKey, timeLabel } = getKyivDateTime();

    if (!isScheduledTime(timeLabel)) return;
    const slotKey = slotKeyForTime(dateKey, timeLabel);

    if (isSlotProcessed(slotKey)) return;
    currentSlot = slotKey;

    let attempts = 0;
    while (attempts < MAX_ATTEMPTS_PER_SLOT) {
      attempts += 1;

      const draft = await getOrCreateCurrentDraft();
      if (!draft) break;

      const html = buildTelegramHtml(draft.title, draft.text, draft.url);

      if (html.length > 4096) {
        markSeen(draft.url);
        currentDraft = null;
        continue;
      }

      const result = await sendMessage(CHANNEL_CHAT_ID, html);

      if (result?.ok) {
        markSeen(draft.url);
        markSlotProcessed(slotKey);
        currentDraft = null;
        break;
      }

      console.error("Scheduled send failed:", result);
      break;
    }
  } catch (error) {
    console.error("processScheduledSlot error:", error);
  }
}

setInterval(() => {
  processScheduledSlot().catch((error) => {
    console.error("schedule interval error:", error);
  });
}, 30 * 1000);

/* ================= SERVER ================= */

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        currentDraftId: currentDraft?.id || null,
        currentDraftUrl: currentDraft?.url || null,
        currentSlot,
      });
    }

    if (req.method === "GET" && req.url === "/draft/current") {
      const draft = await getOrCreateCurrentDraft();

      if (!draft) {
        return sendJson(res, 404, {
          ok: false,
          message: "Чернетка не знайдена",
          draft: null,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        draft,
      });
    }

    if (req.method === "POST" && req.url === "/draft/reject") {
      if (currentDraft?.url) {
        markSeen(currentDraft.url);
      }

      currentDraft = await buildNextDraft();

      if (!currentDraft) {
        return sendJson(res, 404, {
          ok: false,
          message: "Інша новина не знайдена",
        });
      }

      return sendJson(res, 200, {
        ok: true,
        message: "Отримано іншу новину",
        draft: currentDraft,
      });
    }

    if (req.method === "POST" && req.url === "/draft/publish") {
      const body = await parseRequestBody(req);

      const title = cleanupTitle(body.title || currentDraft?.title || "");
      const text = cleanupArticleText(body.text || currentDraft?.text || "");
      const sourceUrl = normalizeUrl(currentDraft?.url || "");
      const imageBase64 = sanitizeBase64(body.imageBase64 || "");
      const imageMimeType = String(body.imageMimeType || "image/jpeg");

      if (!title && !text) {
        return sendJson(res, 400, {
          ok: false,
          message: "Порожній текст",
        });
      }

      const html = buildTelegramHtml(title, text, sourceUrl);

      let result;

      if (imageBase64) {
        const imageBuffer = Buffer.from(imageBase64, "base64");

        if (html.length > 1024) {
          return sendJson(res, 400, {
            ok: false,
            message: "Caption перевищує 1024 символи",
          });
        }

        result = await sendPhotoToTelegram(
          CHANNEL_CHAT_ID,
          html,
          imageBuffer,
          imageMimeType
        );
      } else {
        if (html.length > 4096) {
          return sendJson(res, 400, {
            ok: false,
            message: "Текст перевищує 4096 символів",
          });
        }

        result = await sendMessage(CHANNEL_CHAT_ID, html);
      }

      if (!result?.ok) {
        return sendJson(res, 500, {
          ok: false,
          message: result?.description || "Telegram publish failed",
        });
      }

      if (currentDraft?.url) {
        markSeen(currentDraft.url);
      }

      currentDraft = null;

      return sendJson(res, 200, {
        ok: true,
        message: "Опубліковано",
      });
    }

    return sendJson(res, 404, {
      ok: false,
      message: "Not found",
    });
  } catch (error) {
    console.error("server error:", error);
    return sendJson(res, 500, {
      ok: false,
      message: error.message || "Server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
