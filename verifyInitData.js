const crypto = require('crypto');

/**
 * Проверяет подлинность initData, присланной из Telegram Mini App.
 * См. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * @param {string} initData  сырая строка initData (Telegram.WebApp.initData)
 * @param {string} botToken  токен бота из @BotFather
 * @returns {{ ok: boolean, user: object|null, error?: string }}
 */
function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, user: null, error: 'initData отсутствует' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    return { ok: false, user: null, error: 'hash отсутствует в initData' };
  }
  params.delete('hash');

  // Строка проверки: пары key=value, отсортированные по ключу, через \n
  const dataCheckArr = [];
  for (const [key, value] of params.entries()) {
    dataCheckArr.push(`${key}=${value}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    return { ok: false, user: null, error: 'hash не совпадает — подделанные данные' };
  }

  // Опционально: проверка что initData не старше N часов (auth_date)
  const authDate = Number(params.get('auth_date'));
  const MAX_AGE_SECONDS = 24 * 60 * 60; // 24 часа
  if (authDate && Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { ok: false, user: null, error: 'initData устарела' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (e) {
    // ignore
  }

  return { ok: true, user };
}

module.exports = { verifyInitData };
