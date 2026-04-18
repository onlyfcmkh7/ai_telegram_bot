const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const CHANNEL_CHAT_ID = "-1003675505328";

const TIMEZONE = "Europe/Kyiv";
const SCHEDULE_TIMES = ["11:00", "14:00", "18:00"];

const MAX_ATTEMPTS_PER_SLOT = 5;
const STATE_FILE = path.join(__dirname, "bot_state.json");

const INCRYPTED_NEWS_URL = "https://incrypted.com/ua/novyny/";
const FORKLOG_NEWS_URL = "https://forklog.com.ua/news";

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
    .replace(/Читайте также.*/gi, "")
    .replace(/Читати далі.*/gi, "")
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
            "Accept-Language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
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

/* ================= SOURCES ================= */

async function fetchIncryptedNewsList() {
  try {
    const html = await fetchUrl(INCRYPTED_NEWS_URL);
    const $ = cheerio.load(html);
    const items = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const title = cleanupTitle($(el).text());

      if (!href || !title) return;

      const url = new URL(href, INCRYPTED_NEWS_URL).toString();
      if (!/incrypted\.com\/ua\//i.test(url)) return;
      if (url === INCRYPTED_NEWS_URL) return;
      if (/\/ua\/novyny\/?$/.test(url)) return;
      if (title.length < 25) return;

      items.push({
        sourceName: "Incrypted",
        title,
        url: normalizeUrl(url),
      });
    });

    return dedupeArticles(items).slice(0, 30);
  } catch (error) {
    console.error("fetchIncryptedNewsList error:", error.message);
    return [];
  }
}

async function fetchForklogNewsList() {
  try {
    const html = await fetchUrl(FORKLOG_NEWS_URL);
    const $ = cheerio.load(html);
    const items = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const title = cleanupTitle($(el).text());

      if (!href || !title) return;

      const url = new URL(href, FORKLOG_NEWS_URL).toString();
      if (!/forklog\.com\.ua\//i.test(url)) return;
      if (url === FORKLOG_NEWS_URL) return;
      if (/\/news\/?$/.test(url)) return;
      if (title.length < 25) return;

      items.push({
        sourceName: "ForkLog UA",
        title,
        url: normalizeUrl(url),
      });
    });

    return dedupeArticles(items).slice(0, 30);
  } catch (error) {
    console.error("fetchForklogNewsList error:", error.message);
    return [];
  }
}

function dedupeArticles(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

async function fetchAllNews() {
  const [incrypted, forklog] = await Promise.all([
    fetchIncryptedNewsList(),
    fetchForklogNewsList(),
  ]);

  const merged = dedupeArticles([...incrypted, ...forklog]);
  return merged.filter((item) => !isSeen(item.url));
}

async function extractArticle(url) {
  try {
    const html = await fetchUrl(url);
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();

    let title = cleanupTitle(parsed?.title || "");
    let text = cleanupArticleText(parsed?.textContent || "");

    if (!title || !text) {
      const $ = cheerio.load(html);

      if (!title) {
        title =
          cleanupTitle($("meta[property='og:title']").attr("content")) ||
          cleanupTitle($("title").text()) ||
          cleanupTitle($("h1").first().text());
      }

      if (!text) {
        text =
          cleanupArticleText($("article").text()) ||
          cleanupArticleText($("main").text()) ||
          cleanupArticleText($("body").text());
      }
    }

    return { title, text };
  } catch (error) {
    console.error("extractArticle error:", url, error.message);
    return { title: "", text: "" };
  }
}

/* ================= DRAFT ================= */

async function buildDraftFromUrl(item) {
  const normalizedUrl = normalizeUrl(item.url);
  if (!normalizedUrl) return null;
  if (isSeen(normalizedUrl)) return null;

  const article = await extractArticle(normalizedUrl);

  const finalTitle = cleanupTitle(article.title || item.title || "");
  const finalText = cleanupArticleText(article.text || "");

  if (!finalTitle || !finalText || finalText.length < 120) {
    return null;
  }

  return {
    id: nextDraftId(),
    title: finalTitle,
    description: "",
    text: finalText,
    url: normalizedUrl,
    sourceName: item.sourceName || "",
  };
}

async function buildNextDraft() {
  const items = await fetchAllNews();

  for (const item of items) {
    if (currentDraft?.url && normalizeUrl(currentDraft.url) === normalizeUrl(item.url)) {
      continue;
    }

    try {
      const draft = await buildDraftFromUrl(item);
      if (draft) {
        return draft;
      }
    } catch (error) {
      console.error("buildNextDraft item error:", item.url, error.message);
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
        seenCount: state.seenUrls.length,
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
      const oldUrl = currentDraft?.url || null;

      if (oldUrl) {
        markSeen(oldUrl);
      }

      currentDraft = null;
      currentDraft = await buildNextDraft();

      console.log("REJECT:", {
        oldUrl,
        newUrl: currentDraft?.url || null,
        seenCount: state.seenUrls.length,
      });

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
