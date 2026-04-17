const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const PRIVATE_CHAT_ID = "978193902";
const CHANNEL_CHAT_ID = "-1003675505328";

let lastUpdateId = 0;

const sendRequest = (path, data = null, method = "GET") => {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}${path}`,
      method,
      headers: body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }
        : {},
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
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

  const result = await sendRequest("/sendMessage", payload, "POST");
  console.log("sendMessage:", JSON.stringify(result));
};

const answerCallbackQuery = async (callbackQueryId, text) => {
  const result = await sendRequest(
    "/answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      text,
    },
    "POST"
  );
  console.log("answerCallbackQuery:", JSON.stringify(result));
};

const handleUpdates = async () => {
  const result = await sendRequest(`/getUpdates?offset=${lastUpdateId + 1}`);

  if (!result.ok || !result.result.length) return;

  for (const update of result.result) {
    lastUpdateId = update.update_id;

    if (update.callback_query) {
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
  }
};

console.log("Bot started");

setTimeout(() => {
  sendMessage(PRIVATE_CHAT_ID, "📰 Нова новина:\n\nТут буде текст від ІІ", [
    { text: "✅ Опублікувати", callback_data: "publish" },
    { text: "❌ Відхилити", callback_data: "reject" },
  ]);
}, 5000);

setInterval(() => {
  handleUpdates().catch((error) => {
    console.error("handleUpdates error:", error);
  });
}, 3000);
