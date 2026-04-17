const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;

const sendMessageWithButtons = (chatId, text) => {
  const data = JSON.stringify({
    chat_id: chatId,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Опублікувати", callback_data: "publish" },
          { text: "❌ Відхилити", callback_data: "reject" },
        ],
      ],
    },
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    },
  };

  const req = https.request(options, (res) => {
    let responseData = "";

    res.on("data", (chunk) => {
      responseData += chunk;
    });

    res.on("end", () => {
      console.log("Response:", responseData);
    });
  });

  req.on("error", (error) => {
    console.error("Error:", error);
  });

  req.write(data);
  req.end();
};

console.log("Bot started");

// ТЕСТ — відправка тобі з кнопками
setTimeout(() => {
  sendMessageWithButtons("-1003675505328", "📰 Нова новина:\n\nТут буде текст від ІІ");
}, 5000);
