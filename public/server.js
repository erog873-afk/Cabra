// Запуск: BOT_TOKEN=... ADMIN_ID=123456789 DATABASE_URL=postgres://... node server.js
// ADMIN_ID — ваш Telegram ID (число). Только он может добавлять и удалять задания.
// DATABASE_URL — строка подключения к PostgreSQL (в Render: Internal или External Database URL).
// Проверка заданий: бот должен быть АДМИНИСТРАТОРОМ канала/группы, на которую подписываются.
cюonst http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
// Проверка подписки включена всегда; отключить можно только STRICT_CHECK=0
const STRICT_CHECK = process.env.STRICT_CHECK !== '0';
const MIN_WAIT_MS = 3000; // минимум между «Начать» и «Проверить задание»
const WEEK_MS = 7 * 24 * 3600 * 1000;

if (!BOT_TOKEN || !ADMIN_ID || !DATABASE_URL) {
  console.error('Задайте BOT_TOKEN, ADMIN_ID и DATABASE_URL');
  process.exit(1);
}

// Render PostgreSQL требует SSL. Отключить можно переменной DATABASE_SSL=0 (например, для локальной базы).
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

// ---------- База данных ----------
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    reward NUMERIC(12,2) NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    stars NUMERIC(14,2) NOT NULL DEFAULT 0,
    done TEXT[] NOT NULL DEFAULT '{}',
    started JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE INDEX IF NOT EXISTS users_stars_idx ON users (stars DESC)`);
  // История всех изменений баланса: что, сколько и за что начислено
  await q(`CREATE TABLE IF NOT EXISTS star_log (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    delta NUMERIC(14,2) NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS leaders_cycle (id INT PRIMARY KEY, end_at BIGINT NOT NULL)`);
  await q(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
}

// Один раз переносим старые JSON-файлы (tasks.json, users.json, leaders-cycle.json), если они лежат рядом с сервером.
async function migrateOnce() {
  const flag = await q(`SELECT 1 FROM meta WHERE key = 'json_migrated'`);
  if (flag.rowCount) return;
  const readJ = f => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch { return null; } };
  const tasks = readJ('tasks.json');
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      await q(`INSERT INTO tasks (id,title,url,reward,icon) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [String(t.id), String(t.title || ''), String(t.url || ''), Number(t.reward) || 0, String(t.icon || '')]);
    }
    console.log('[migrate] заданий перенесено:', tasks.length);
  }
  const users = readJ('users.json');
  if (users && typeof users === 'object') {
    for (const [id, u] of Object.entries(users)) {
      await q(`INSERT INTO users (id,name,photo,stars,done,started) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [id, u.name || '', u.photo || '', Number(u.stars) || 0, Array.isArray(u.done) ? u.done : [], JSON.stringify(u.started || {})]);
    }
    console.log('[migrate] пользователей перенесено:', Object.keys(users).length);
  }
  const cyc = readJ('leaders-cycle.json');
  if (cyc && Number(cyc.end)) {
    await q(`INSERT INTO leaders_cycle (id,end_at) VALUES (1,$1) ON CONFLICT (id) DO NOTHING`, [Number(cyc.end)]);
  }
  await q(`INSERT INTO meta (key,value) VALUES ('json_migrated','1') ON CONFLICT (key) DO NOTHING`);
}

// Тестовое задание создаём один раз на новой базе. После удаления оно не вернётся.
async function seedOnce() {
  const flag = await q(`SELECT 1 FROM meta WHERE key = 'seeded'`);
  if (flag.rowCount) return;
  const cnt = Number((await q(`SELECT count(*) AS c FROM tasks`)).rows[0].c);
  if (cnt === 0) {
    let icon = '';
    for (const f of ['index.html', 'tasks.html']) {
      try { icon = fs.readFileSync(path.join(__dirname, f), 'utf8').match(/DEFAULT_ICON\s*=\s*"(data:image\/png;base64,[A-Za-z0-9+\/=]+)"/)[1]; break; } catch {}
    }
    await q(`INSERT INTO tasks (id,title,url,reward,icon) VALUES ('test-task',$1,$2,1,$3) ON CONFLICT (id) DO NOTHING`,
      ['Тестовое задание', process.env.TEST_CHANNEL || 'https://t.me/your_channel', icon]);
  }
  await q(`INSERT INTO meta (key,value) VALUES ('seeded','1') ON CONFLICT (key) DO NOTHING`);
}

// Пользователь заводится при первом заходе; имя и фото обновляются, если изменились.
async function touchUser(uid, name, photo) {
  await q(`INSERT INTO users (id,name,photo) VALUES ($1,$2,$3)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, photo = EXCLUDED.photo, updated_at = now()
    WHERE users.name IS DISTINCT FROM EXCLUDED.name OR users.photo IS DISTINCT FROM EXCLUDED.photo`,
    [uid, name, photo]);
}

// Таймер лидеров: 7 дней. Когда цикл заканчивается, начинается новый.
async function cycleEnd() {
  const now = Date.now();
  await q(`INSERT INTO leaders_cycle (id,end_at) VALUES (1,$1) ON CONFLICT (id) DO NOTHING`, [now + WEEK_MS]);
  const r = await q(`UPDATE leaders_cycle SET end_at = $1 WHERE id = 1 AND end_at <= $2 RETURNING end_at`, [now + WEEK_MS, now]);
  if (r.rowCount) return Number(r.rows[0].end_at);
  return Number((await q(`SELECT end_at FROM leaders_cycle WHERE id = 1`)).rows[0].end_at);
}

async function getTask(id) {
  const r = await q(`SELECT id, title, url, reward::float8 AS reward, icon FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// ---------- Telegram ----------
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
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// Подписан ли пользователь на канал/группу из ссылки https://t.me/<username>.
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

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg'
};
const PRIVATE = new Set(['server.js', 'package.json', 'package-lock.json', 'tasks.json', 'users.json', 'leaders-cycle.json']);

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 300000) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    // Статика: index.html и файлы рядом с ним. Служебные файлы отдавать нельзя.
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
    if (!user) {
      console.log('[auth] 401: initData ' + (req.headers['x-init-data'] ? 'не прошла проверку подписи' : 'отсутствует'));
      return send(res, 401, { error: 'Откройте приложение из Telegram' });
    }
    const isAdmin = String(user.id) === String(ADMIN_ID);
    const uid = String(user.id);
    const nm = [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 40) || user.username || ('ID ' + uid.slice(-4));
    const ph = typeof user.photo_url === 'string' && /^https:\/\//.test(user.photo_url) ? user.photo_url : '';
    await touchUser(uid, nm, ph);

    // Таблица лидеров: топ-50 по балансу + место текущего пользователя (чужие ID не отдаём)
    if (req.method === 'GET' && url.pathname === '/api/leaders') {
      const rows = (await q(`SELECT id, name, photo, stars::float8 AS stars FROM users
        WHERE stars > 0 ORDER BY stars DESC, id LIMIT 50`)).rows;
      const total = Number((await q(`SELECT count(*) AS c FROM users WHERE stars > 0`)).rows[0].c);
      const mine = (await q(`SELECT name, photo, stars::float8 AS stars FROM users WHERE id = $1`, [uid])).rows[0]
        || { name: '', photo: '', stars: 0 };
      const myRank = mine.stars > 0
        ? Number((await q(`SELECT count(*) + 1 AS r FROM users WHERE stars > $1`, [mine.stars])).rows[0].r)
        : null;
      const top = rows.map((x, i) => ({ rank: i + 1, name: x.name || ('ID ' + x.id.slice(-4)), photo: x.photo, stars: x.stars, me: x.id === uid }));
      const endsAt = await cycleEnd();
      return send(res, 200, { top, me: { rank: myRank, stars: mine.stars, photo: mine.photo, name: mine.name }, total, endsAt });
    }

    // Список заданий + баланс и отметки «выполнено»
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const tasks = (await q(`SELECT id, title, url, reward::float8 AS reward, icon FROM tasks ORDER BY created_at, id`)).rows;
      const me = (await q(`SELECT stars::float8 AS stars, done FROM users WHERE id = $1`, [uid])).rows[0] || { stars: 0, done: [] };
      return send(res, 200, { tasks: tasks.map(t => ({ ...t, done: me.done.includes(t.id) })), isAdmin, stars: Number(me.stars) });
    }

    // Нажал «Начать»: запоминаем момент
    const st = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/start$/);
    if (req.method === 'POST' && st) {
      const task = await getTask(st[1]);
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      await q(`UPDATE users SET started = started || jsonb_build_object($2::text, $3::bigint)
        WHERE id = $1 AND NOT (started ? $2::text)`, [uid, task.id, Date.now()]);
      return send(res, 200, { ok: true });
    }

    // Проверка выполнения задания
    const chk = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/check$/);
    if (req.method === 'POST' && chk) {
      const task = await getTask(chk[1]);
      if (!task) return send(res, 404, { error: 'Задание не найдено' });
      const me = (await q(`SELECT stars::float8 AS stars, done, started FROM users WHERE id = $1`, [uid])).rows[0];
      if (me.done.includes(task.id)) return send(res, 200, { ok: true, already: true, stars: Number(me.stars) });
      const startedAt = Number((me.started || {})[task.id]);
      if (!startedAt || Date.now() - startedAt < MIN_WAIT_MS) return send(res, 200, { ok: false, notDone: true, error: 'Вы не выполнили задание' });
      if (STRICT_CHECK) {
        const result = await checkSubscription(task.url, user.id);
        if (!result.ok) return send(res, 200, { ok: false, notDone: !!result.notDone, error: result.error });
      }
      // Атомарное начисление: если задание уже засчитано параллельным запросом, ничего не начислится дважды
      const claimed = await q(`UPDATE users SET stars = ROUND(stars + $2::numeric, 2), done = array_append(done, $3::text)
        WHERE id = $1 AND NOT ($3::text = ANY(done)) RETURNING stars::float8 AS stars`, [uid, task.reward, task.id]);
      if (claimed.rowCount) {
        await q(`INSERT INTO star_log (user_id, delta, reason, ref) VALUES ($1, $2, 'task', $3)`, [uid, task.reward, task.id]);
      }
      const stars = claimed.rowCount
        ? Number(claimed.rows[0].stars)
        : Number((await q(`SELECT stars::float8 AS stars FROM users WHERE id = $1`, [uid])).rows[0].stars);
      return send(res, 200, { ok: true, reward: task.reward, stars });
    }

    // Дальше только для администратора
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
      await q(`INSERT INTO tasks (id,title,url,reward,icon) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), title, link, reward, icon]);
      return send(res, 200, { ok: true });
    }

    const del = url.pathname.match(/^\/api\/admin\/tasks\/([\w-]+)$/);
    if (req.method === 'DELETE' && del) {
      await q(`DELETE FROM tasks WHERE id = $1`, [del[1]]);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.log('[error]', e.message);
    send(res, 400, { error: 'Некорректный запрос' });
  }
}

(async () => {
  await initDb();
  await migrateOnce();
  await seedOnce();
  http.createServer(handle).listen(PORT, '0.0.0.0', () => console.log('Server started on port ' + PORT));
})().catch(e => {
  console.error('Не удалось подготовить базу:', e.message);
  process.exit(1);
});
