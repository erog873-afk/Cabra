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
// Как засчитывается задание: человек нажимает «Начать» (переходит по ссылке), возвращается и жмёт «Проверить задание» —
// награда зачисляется сразу. STRICT_CHECK=1 в Render включает настоящую проверку подписки через Telegram
// (тогда бот должен быть администратором канала).
const STRICT_CHECK = process.env.STRICT_CHECK !== '0'; // проверка подписки включена всегда; отключить можно только STRICT_CHECK=0
const MIN_WAIT_MS = 3000; // минимум секунд между «Начать» и «Проверить задание»
if (!BOT_TOKEN || !ADMIN_ID) { console.error('Задайте BOT_TOKEN и ADMIN_ID'); process.exit(1); }

const DB = path.join(__dirname, 'tasks.json');
const USERS = path.join(__dirname, 'users.json'); // { "<telegram id>": { stars: 0, done: ["<task id>"] } }
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const load = () => readJson(DB, []);
const save = t => fs.writeFileSync(DB, JSON.stringify(t, null, 2));
const loadUsers = () => readJson(USERS, {});
const saveUsers = u => fs.writeFileSync(USERS, JSON.stringify(u, null, 2));

// Таймер лидеров: 7 дней. Конец цикла хранится в файле; когда он наступает, начинается новый цикл на 7 дней.
const CYCLE = path.join(__dirname, 'leaders-cycle.json');
const WEEK_MS = 7 * 24 * 3600 * 1000;
function cycleEnd() {
  let end = 0;
  try { end = Number(JSON.parse(fs.readFileSync(CYCLE, 'utf8')).end) || 0; } catch {}
  const now = Date.now();
  if (!end || end <= now) {
    end = now + WEEK_MS;
    try { fs.writeFileSync(CYCLE, JSON.stringify({ end })); } catch {}
  }
  return end;
}

// ТЕСТ: если файла с заданиями ещё нет, создаём одно тестовое. Удалите его кнопкой «Удалить» в админ-панели.
// После удаления оно не вернётся (файл уже существует). Ссылку можно задать переменной TEST_CHANNEL в Render.
if (!fs.existsSync(DB)) {
  let icon = '';
  for (const f of ['index.html', 'tasks.html']) {
    try { icon = fs.readFileSync(path.join(__dirname, f), 'utf8').match(/DEFAULT_ICON\s*=\s*"(data:image\/png;base64,[A-Za-z0-9+\/=]+)"/)[1]; break; } catch {}
  }
  save([{ id: 'test-task', title: 'Тестовое задание', url: process.env.TEST_CHANNEL || 'https://t.me/your_channel', reward: 1, icon }]);
}

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
    return { ok: false, notDone: true, error: 'Вы не выполнили задание' };
  } catch (e) {
    console.log('[check] network error:', e.message);
    return { ok: false, error: 'Не удалось связаться с Telegram. Попробуйте позже.' };
  }
}

// ---------- Tgrass ----------
// Ключ задайте переменной TGRASS_API_KEY в Render. Награда за каждое задание — TGRASS_REWARD (по умолчанию 1).
const TGRASS_API_URL = 'https://tgrass.space/offers';
const TGRASS_API_KEY = process.env.TGRASS_API_KEY || '';
const TGRASS_REWARD = Number(process.env.TGRASS_REWARD) || 1;
const tgId = link => 'tg-' + crypto.createHash('sha1').update(String(link)).digest('hex').slice(0, 12);

// Запрос к Tgrass. Возвращает JSON ответа или null (ошибка/нет ключа).
async function tgrassFetch(user) {
  if (!TGRASS_API_KEY) return null;
  try {
    const r = await fetch(TGRASS_API_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'Content-Type': 'application/json', Auth: TGRASS_API_KEY },
      body: JSON.stringify({
        tg_user_id: Number(user.id),
        tg_login: user.username || null,
        lang: user.language_code || 'ru',
        is_premium: !!user.is_premium
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) { console.log('[tgrass] HTTP', r.status); return null; }
    return await r.json();
  } catch (e) { console.log('[tgrass] error:', e.message); return null; }
}

// Задания Tgrass для списка. Запоминаем, какие офферы показали (tgPending): награда выдаётся только за них.
async function tgrassTasks(user, uid) {
  const d = await tgrassFetch(user);
  if (!d) return [];
  const users = loadUsers();
  const me = users[uid] || (users[uid] = { stars: 0, done: [] });
  const doneSet = new Set(me.tgDone || []);
  const ru = (user.language_code || 'ru') !== 'en';
  const names = ru
    ? { channel: 'Подписаться на канал', bot: 'Запустить бота', other: 'Выполнить задание' }
    : { channel: 'Subscribe to channel', bot: 'Start the bot', other: 'Complete the task' };
  let list = [];
  if (d.status === 'not_ok') {
    list = (d.offers || [])
      .filter(o => o && /^https:\/\//.test(String(o.link)))
      .map(o => ({
        id: tgId(o.link),
        title: String(o.name || o.title || names[o.type] || names.other).slice(0, 80),
        url: o.link, reward: TGRASS_REWARD, icon: '', done: false, partner: true
      }))
      .filter(t => !doneSet.has(t.id));
  }
  const ids = list.map(t => t.id);
  if (JSON.stringify(me.tgPending || []) !== JSON.stringify(ids)) { me.tgPending = ids; saveUsers(users); }
  return list;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg'
};
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json']);

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 300000) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Статика: index.html и подключаемые к нему файлы (cases-store.js, balance-widget.js, roulette.html, картинки...).
    // Служебные файлы (server.js, package.json, *.json с данными) отдавать нельзя.
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 404, { error: 'Не найдено' });
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(__dirname, name);
      const ext = path.extname(file).toLowerCase();
      const ok = file.startsWith(__dirname + path.sep) && MIME[ext] && !PRIVATE.has(path.basename(file)) &&
        fs.existsSync(file) && fs.statSync(file).isFile();
      if (!ok) return send(res, 404, { error: 'Не найдено' });
      res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache' });
      return res.end(fs.readFileSync(file));
    }

    const user = verify(req.headers['x-init-data']);
    if (!user) { console.log('[auth] 401: initData ' + (req.headers['x-init-data'] ? 'не прошла проверку подписи (BOT_TOKEN не от этого бота?)' : 'отсутствует (открыто не из Telegram)')); return send(res, 401, { error: 'Откройте приложение из Telegram' }); }
    const isAdmin = String(user.id) === String(ADMIN_ID);
    if (url.pathname.startsWith('/api/admin/') && !isAdmin) console.log('[auth] 403: id ' + user.id + ' не равен ADMIN_ID');
    const uid = String(user.id);

    // Запоминаем имя и фото для таблицы лидеров (пишем на диск, только если что-то изменилось)
    {
      const all = loadUsers();
      const rec = all[uid];
      const nm = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 40) || user.username || ('ID ' + uid.slice(-4));
      const ph = typeof user.photo_url === 'string' && /^https:\/\//.test(user.photo_url) ? user.photo_url : '';
      if (rec && (rec.name !== nm || rec.photo !== ph)) { rec.name = nm; rec.photo = ph; saveUsers(all); }
    }

    // Таблица лидеров: топ-50 по балансу (звёздам) + место текущего пользователя (чужие ID не отдаём)
    if (req.method === 'GET' && url.pathname === '/api/leaders') {
      const all = loadUsers();
      const list = Object.entries(all)
        .filter(([, u]) => u && Number(u.stars) > 0)
        .map(([id, u]) => ({ id, name: u.name || ('ID ' + id.slice(-4)), photo: u.photo || '', stars: Number(u.stars) }))
        .sort((a, b) => b.stars - a.stars);
      const myIdx = list.findIndex(x => x.id === uid);
      const top = list.slice(0, 50).map((x, i) => ({ rank: i + 1, name: x.name, photo: x.photo, stars: x.stars, me: x.id === uid }));
      const meStars = Number((all[uid] || {}).stars) || 0;
      const mine = all[uid] || {};
      return send(res, 200, { top, me: { rank: myIdx >= 0 ? myIdx + 1 : null, stars: meStars, photo: mine.photo || '', name: mine.name || '' }, total: list.length, endsAt: cycleEnd() });
    }

    // Список заданий + баланс и отметки «выполнено» для этого пользователя
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const me = loadUsers()[uid] || { stars: 0, done: [] };
      const tasks = load().map(t => ({ ...t, done: me.done.includes(t.id) }));
      const partner = await tgrassTasks(user, uid);
      return send(res, 200, { tasks: tasks.concat(partner), isAdmin, stars: me.stars });
    }

    // Человек нажал «Начать»: запоминаем момент (доступно любому пользователю)
    const st = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/start$/);
    if (req.method === 'POST' && st && st[1].startsWith('tg-')) return send(res, 200, { ok: true });
    if (req.method === 'POST' && st) {
      const task = load().find(t => t.id === st[1]);
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      const users = loadUsers();
      const me = users[uid] || (users[uid] = { stars: 0, done: [] });
      me.started = me.started || {};
      if (!me.started[task.id]) me.started[task.id] = Date.now();
      saveUsers(users);
      return send(res, 200, { ok: true });
    }

    // Проверка выполнения задания (доступно любому пользователю)
    const chk = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/check$/);
    if (req.method === 'POST' && chk && chk[1].startsWith('tg-')) {
      const notDone = { ok: false, notDone: true, error: 'Вы не выполнили задание' };
      const before = loadUsers()[uid];
      if (!before || !(before.tgPending || []).length) return send(res, 200, notDone);
      const d = await tgrassFetch(user);
      if (!d) return send(res, 200, { ok: false, error: 'Не удалось проверить задание. Попробуйте позже.' });
      if (d.status !== 'ok') return send(res, 200, notDone);
      // Tgrass подтвердил выполнение всех офферов. Награда — за те, что мы показывали (повторно не выдаётся).
      const fresh = loadUsers();
      const cur = fresh[uid] || (fresh[uid] = { stars: 0, done: [] });
      const pending = cur.tgPending || [];
      if (!pending.length) return send(res, 200, { ok: true, already: true, stars: cur.stars });
      const reward = Math.round(pending.length * TGRASS_REWARD * 100) / 100;
      cur.tgDone = (cur.tgDone || []).concat(pending).slice(-1000);
      cur.tgPending = [];
      cur.stars = Math.round((cur.stars + reward) * 100) / 100;
      saveUsers(fresh);
      return send(res, 200, { ok: true, reward, stars: cur.stars });
    }
    if (req.method === 'POST' && chk) {
      const task = load().find(t => t.id === chk[1]);
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      const users = loadUsers();
      const me = users[uid] || (users[uid] = { stars: 0, done: [] });
      if (me.done.includes(task.id)) return send(res, 200, { ok: true, already: true, stars: me.stars });
      const startedAt = (me.started || {})[task.id];
      if (!startedAt || Date.now() - startedAt < MIN_WAIT_MS) return send(res, 200, { ok: false, notDone: true, error: 'Вы не выполнили задание' });
      if (STRICT_CHECK) {
        const result = await checkSubscription(task.url, user.id);
        if (!result.ok) return send(res, 200, { ok: false, notDone: !!result.notDone, error: result.error });
      }
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
}).listen(PORT, '0.0.0.0', () => console.log('Server started on port ' + PORT));

