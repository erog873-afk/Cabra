// Запуск: BOT_TOKEN=... ADMIN_ID=123456789 node server.js   (нужен Node 18+, зависимостей нет)
// ADMIN_ID — ваш Telegram ID (число). Только он может добавлять и удалять задания.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ТЕСТ: значения по умолчанию. Перед настоящим запуском удалите их и задайте переменные в Render.
const BOT_TOKEN = process.env.BOT_TOKEN || '8758871773:AAFoZe3Mc2tX8e_JwXdE1xgCJ6Oh3pRzB0s';
const ADMIN_ID = process.env.ADMIN_ID || '8642237301';
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !ADMIN_ID) { console.error('Задайте BOT_TOKEN и ADMIN_ID'); process.exit(1); }

const DB = path.join(__dirname, 'tasks.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const save = t => fs.writeFileSync(DB, JSON.stringify(t, null, 2));

// Проверка подписи initData по документации Telegram. Возвращает пользователя или null.
function verify(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); params.delete('hash');
  if (!hash) return null;
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const ok = calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  if (!ok) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null; // старше суток
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 300000) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/tasks.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'tasks.html')));
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });

    const user = verify(req.headers['x-init-data']);
    if (!user) return send(res, 401, { error: 'Откройте приложение из Telegram' });
    const isAdmin = String(user.id) === String(ADMIN_ID);

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      return send(res, 200, { tasks: load(), isAdmin });
    }

    // Дальше только для администратора. Проверка делается здесь, на сервере.
    if (!isAdmin) return send(res, 403, { error: 'Нет доступа' });

    if (req.method === 'POST' && url.pathname === '/api/admin/tasks') {
      const d = await body(req);
      const title = String(d.title || '').trim().slice(0, 80);
      const link = String(d.url || '').trim();
      const reward = Math.round(Number(d.reward) * 100) / 100;
      const icon = String(d.icon || '');
      if (!title) return send(res, 400, { error: 'Введите название' });
      if (!/^https:\/\//.test(link) || link.length > 500) return send(res, 400, { error: 'Некорректная ссылка' });
      if (!(reward > 0 && reward <= 100000)) return send(res, 400, { error: 'Некорректная награда' });
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon) || icon.length > 200000) return send(res, 400, { error: 'Некорректная иконка' });
      const tasks = load();
      tasks.push({ id: crypto.randomUUID(), title, url: link, reward, icon });
      save(tasks);
      return send(res, 200, { ok: true });
    }

    const del = url.pathname.match(/^\/api\/admin\/tasks\/([\w-]+)$/);
    if (req.method === 'DELETE' && del) {
      save(load().filter(t => t.id !== del[1]));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    send(res, 400, { error: 'Некорректный запрос' });
  }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
