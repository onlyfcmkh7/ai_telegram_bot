const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

let lastUpdateId = 0;

const sendRequest = (hostname, path, data = null, method = "GET") => {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;

    const options = {
      hostname,
      path,
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

const telegramRequest = (path, data = null, method = "GET") => {
  return sendRequest("api.telegram.org", `/bot${TOKEN}${path}`, data, method);
};

const sendMessage = async (chatId, text, buttons = null) => {
  const payload = {
    chat_id: chatId,
    text,
  };

  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: [buttons],
    };
  }

  const result = await telegramRequest("/sendMessage", payload, "POST");
  console.log("sendMessage:", JSON.stringify(result));
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
};

const getCryptoNews = async () => {
  const query = encodeURIComponent("crypto");

  const result = await sendRequest(
    "newsapi.org",
    `/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=1&apiKey=${NEWS_API_KEY}`,
    null,
    "GET"
  );

  console.log("NEWS RESULT:", JSON.stringify(result));

  if (!result.articles || !result.articles.length) {
    throw new Error("No crypto news found");
  }

  const article = result.articles[0];

  return {
    title: article.title || "Без заголовка",
    description: article.description || "Опис відсутній",
    url: article.url || "",
  };
};

const buildDraftText = (article) => {
  return `📰 Крипто-новина:\n\n${article.title}\n\n${article.description}\n\nДжерело: ${article.url}`;
};

const handleUpdates = async () => {
  const result = await telegramRequest(`/getUpdates?offset=${lastUpdateId + 1}`);

  if (!result.ok || !result.result || !result.result.length) return;

  for (const update of result.result) {
    lastUpdateId = update.update_id;

    if (!update.callback_query) continue;

    const callback = update.callback_query;
    const action = callback.data;
    const callbackId = callback.id;
    const draftText = callback.message.text;

    if (action === "publish") {
      await sendMessage(CHANNEL_CHAT_ID, draftText);
      await answerCallbackQuery(callbackId, "Опубліковано в канал ✅");
    }

    if (action === "reject") {
      await answerCallbackQuery(callbackId, "Відхилено ❌");
    }
  }
};

const sendCryptoDraftToPrivate = async () => {
  const article = await getCryptoNews();
  const draftText = buildDraftText(article);

  await sendMessage(PRIVATE_CHAT_ID, draftText, [
    { text: "✅ Опублікувати", callback_data: "publish" },
    { text: "❌ Відхилити", callback_data: "reject" },
  ]);
};

console.log("Bot started");

setTimeout(() => {
  sendCryptoDraftToPrivate().catch((error) => {
    console.error("sendCryptoDraftToPrivate error:", error);
  });
}, 5000);

setInterval(() => {
  handleUpdates().catch((error) => {
    console.error("handleUpdates error:", error);
  });
}, 3000);
