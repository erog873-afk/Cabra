// Запуск: BOT_TOKEN=... ADMIN_ID=123456789 node server.js   (нужен Node 18+, зависимостей нет)
// ADMIN_ID — ваш Telegram ID (число). Только он может добавлять и удалять задания.
// Проверка заданий: бот должен быть АДМИНИСТРАТОРОМ канала/группы, на которую подписываются.
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
const USERS = path.join(__dirname, 'users.json'); // { "<telegram id>": { stars: 0, done: ["<task id>"] } }
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const load = () => readJson(DB, []);
const save = t => fs.writeFileSync(DB, JSON.stringify(t, null, 2));
const loadUsers = () => readJson(USERS, {});
const saveUsers = u => fs.writeFileSync(USERS, JSON.stringify(u, null, 2));

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

// Подписан ли пользователь на канал/группу из ссылки https://t.me/<username>.
// Возвращает { ok: true } или { ok: false, error: 'текст для пользователя' }.
async function checkSubscription(link, userId) {
  const m = String(link).match(/^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:[?#].*)?$/);
  if (!m) return { ok: false, error: 'Для этого задания автоматическая проверка недоступна: нужна публичная ссылка вида https://t.me/название.' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '@' + m[1], user_id: Number(userId) })
    });
    const d = await r.json();
    if (!d.ok) {
      console.log('[check] getChatMember error:', d.description);
      return { ok: false, error: 'Не удалось проверить подписку. Бот должен быть администратором этого канала.' };
    }
    const status = d.result && d.result.status;
    if (['creator', 'administrator', 'member'].includes(status) || (status === 'restricted' && d.result.is_member)) return { ok: true };
    return { ok: false, error: 'Вы ещё не подписались. Подпишитесь и нажмите «Проверить задание» снова.' };
  } catch (e) {
    console.log('[check] network error:', e.message);
    return { ok: false, error: 'Не удалось связаться с Telegram. Попробуйте позже.' };
  }
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
    const uid = String(user.id);

    // Список заданий + баланс и отметки «выполнено» для этого пользователя
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const me = loadUsers()[uid] || { stars: 0, done: [] };
      const tasks = load().map(t => ({ ...t, done: me.done.includes(t.id) }));
      return send(res, 200, { tasks, isAdmin, stars: me.stars });
    }

    // Проверка выполнения задания (доступно любому пользователю)
    const chk = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/check$/);
    if (req.method === 'POST' && chk) {
      const task = load().find(t => t.id === chk[1]);
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      const users = loadUsers();
      const me = users[uid] || (users[uid] = { stars: 0, done: [] });
      if (me.done.includes(task.id)) return send(res, 200, { ok: true, already: true, stars: me.stars });
      const result = await checkSubscription(task.url, user.id);
      if (!result.ok) return send(res, 200, { ok: false, error: result.error });
      // Повторная проверка после await: на случай двух одновременных запросов
      const fresh = loadUsers();
      const cur = fresh[uid] || (fresh[uid] = { stars: 0, done: [] });
      if (!cur.done.includes(task.id)) {
        cur.done.push(task.id);
        cur.stars = Math.round((cur.stars + task.reward) * 100) / 100;
        saveUsers(fresh);
      }
      return send(res, 200, { ok: true, reward: task.reward, stars: cur.stars });
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
