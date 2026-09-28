// Бэкенд пополнения баланса звёздами Telegram. Node 18+, без зависимостей.
// Отдаёт также папку public/ (index.html и т.д.). Запуск: BOT_TOKEN=123:ABC WEBHOOK_SECRET=любая_строка PORT=3000 node server.js
// Один раз привязать вебхук (после деплоя на https):
// curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
//   -d url="https://ВАШ_ДОМЕН/webhook/$WEBHOOK_SECRET" \
//   -d 'allowed_updates=["pre_checkout_query","message"]'
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const BOT_TOKEN = process.env.BOT_TOKEN || '8239960804:AAHDFegF3O-PmKwf2fh5VU5dDRZFHasBpgg';
const SECRET = process.env.WEBHOOK_SECRET || 'ВСТАВЬ_СЮДА_ЛЮБУЮ_ДЛИННУЮ_СТРОКУ';
const DB_FILE = './db.json';
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { balances: {}, charges: {} };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const tgApi = (m, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

// Проверка подписи initData от Telegram Mini App
function userFromInitData(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(check).digest('hex');
  if (calc !== hash || Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  return JSON.parse(p.get('user'));
}
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s ? JSON.parse(s) : {})); });

http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') return send(204, {});
  try {
    // Вебхук от Telegram: тут и зачисляются деньги
    if (req.method === 'POST' && req.url === `/webhook/${SECRET}`) {
      const u = await readBody(req);
      if (u.pre_checkout_query) {
        await tgApi('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
      }
      const sp = u.message && u.message.successful_payment;
      if (sp) {
        const id = sp.telegram_payment_charge_id;
        if (!db.charges[id]) { // защита от повторной доставки
          const uid = String(u.message.from.id);
          db.charges[id] = { uid, amount: sp.total_amount };
          db.balances[uid] = (db.balances[uid] || 0) + sp.total_amount;
          save();
        }
      }
      return send(200, { ok: true });
    }
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(PUBLIC, path.normalize(p));
      if (f.startsWith(PUBLIC + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    const user = userFromInitData(req.headers['x-init-data']);
    if (!user) return send(401, { error: 'unauthorized' });
    const uid = String(user.id);
    if (req.method === 'GET' && req.url === '/api/balance') return send(200, { balance: db.balances[uid] || 0 });
    if (req.method === 'POST' && req.url === '/api/topup/create') {
      const amount = Math.floor(Number((await readBody(req)).amount));
      if (!(amount >= 1 && amount <= 10000)) return send(400, { error: 'bad amount' });
      const r = await tgApi('createInvoiceLink', {
        title: 'Пополнение баланса', description: `${amount} звёзд на баланс`,
        payload: `topup:${uid}:${Date.now()}`, currency: 'XTR', prices: [{ label: 'Звёзды', amount }] });
      return r.ok ? send(200, { link: r.result }) : send(502, { error: r.description });
    }
    send(404, { error: 'not found' });
  } catch (e) { console.error(e); send(500, { error: 'server error' }); }
}).listen(process.env.PORT || 3000);
