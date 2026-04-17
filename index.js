const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;

const sendMessage = (chatId, text) => {
const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

const data = JSON.stringify({
chat_id: chatId,
text: text,
});

const options = {
method: "POST",
headers: {
"Content-Type": "application/json",
"Content-Length": data.length,
},
};

const req = https.request(url, options, (res) => {
res.on("data", (d) => {
console.log("Response:", d.toString());
});
});

req.on("error", (error) => {
console.error(error);
});

req.write(data);
req.end();
};

console.log("Bot started");

// тестове повідомлення (вставиш свій chat_id далі)
setTimeout(() => {
sendMessage("YOUR_CHAT_ID", "Бот працює 🚀");
}, 5000);
