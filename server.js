require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { getSettings, saveSettings } = require('./db');
const { verifyInitData } = require('./verifyInitData');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEV_MODE = process.env.DEV_MODE === 'true';

if (DEV_MODE) {
  console.warn(
    '⚠️  DEV_MODE=true — проверка initData ОТКЛЮЧЕНА. Не использовать в проде!'
  );
}

/**
 * Достаёт и проверяет telegram_user_id из запроса.
 * В DEV_MODE достаточно передать user_id напрямую (для локальных тестов через curl/Postman).
 * В боевом режиме обязателен заголовок X-Telegram-Init-Data с Telegram.WebApp.initData.
 */
function resolveUserId(req) {
  if (DEV_MODE) {
    const userId = req.query.user_id || req.body?.user_id;
    if (!userId) return { error: 'user_id обязателен в DEV_MODE' };
    return { userId: Number(userId) };
  }

  const initData = req.headers['x-telegram-init-data'];
  if (!BOT_TOKEN) {
    return { error: 'BOT_TOKEN не задан на сервере' };
  }
  const result = verifyInitData(initData, BOT_TOKEN);
  if (!result.ok) {
    return { error: result.error || 'Неверная initData' };
  }
  if (!result.user?.id) {
    return { error: 'user.id не найден в initData' };
  }
  return { userId: result.user.id };
}

// GET /api/settings?user_id=123        (DEV_MODE)
// GET /api/settings                    (прод, с заголовком X-Telegram-Init-Data)
app.get('/api/settings', (req, res) => {
  const { userId, error } = resolveUserId(req);
  if (error) return res.status(401).json({ error });

  const settings = getSettings(userId) || {
    userId,
    language: 'ru',
    vibration: true
  };

  res.json(settings);
});

// POST /api/settings  body: { user_id, language, vibration }   (DEV_MODE)
// POST /api/settings  body: { language, vibration } + заголовок X-Telegram-Init-Data  (прод)
app.post('/api/settings', (req, res) => {
  const { userId, error } = resolveUserId(req);
  if (error) return res.status(401).json({ error });

  const { language, vibration } = req.body || {};

  if (language !== 'ru' && language !== 'en') {
    return res.status(400).json({ error: "language должен быть 'ru' или 'en'" });
  }
  if (typeof vibration !== 'boolean') {
    return res.status(400).json({ error: 'vibration должен быть true/false' });
  }

  const settings = saveSettings(userId, language, vibration);
  res.json(settings);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ApexLoot settings API запущен на http://localhost:${PORT}`);
});
